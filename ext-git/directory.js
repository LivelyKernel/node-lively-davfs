var jsDAV_FS_Directory = require('jsDAV/lib/DAV/backends/fs/directory');
var jsDAV_FS_File = require('jsDAV/lib/DAV/backends/fs/file');
var jsDAV_GIT_File = require('./file');

var exec = require('child_process').execFile;
var path = require('path');
var fs = require('fs');
var gitHelper = require('./helper');

// copied from jsDAV/lib/DAV/backends/fs/directory
var Exc = require('jsDAV/lib/shared/exceptions');
var Async = require('jsDAV/node_modules/asyncjs');

var jsDAV_GIT_Directory = module.exports = jsDAV_FS_Directory.extend({

    initialize: function(path, gitRootPath, gitBranch) {
        this.path = path;
        this.gitRootPath = gitRootPath;
        this.gitBranch = gitBranch;
    },

    createFile: function(name, data, enc, cbcreatefile) {
        var newPath = path.relative(this.gitRootPath, this.path + '/' + name),
            self = this;
        if (data.length === 0) {
            data = new Buffer(0);
            enc  = "binary";
        }
        gitHelper.isIgnored(this.gitRootPath, newPath, function(err, ignored) {
            if (err) return cbcreatefile(err);

            if (ignored)
                jsDAV_FS_Directory.createFile.call(self, name, data, enc, cbcreatefile);
            else
                gitHelper.writeFile(self.gitBranch, self.gitRootPath, newPath, data, enc || 'utf8', cbcreatefile);
        })
    },

    createFileStream: undefined, // delete createFileStream from jsDAV_FS_Directory
    createFileStreamRaw: undefined, // delete createFileStreamRaw from jsDAV_FS_Directory
    writeFileChunk: undefined, // delete writeFileChunk from jsDAV_FS_Directory

    createDirectory: function(name, cbcreatedir) {
        var newPath = path.relative(this.gitRootPath, this.path + '/' + name);
        gitHelper.mkDir(this.gitBranch, this.gitRootPath, newPath, cbcreatedir);
    },

    getChild: function(name, cbgetchild) {
        var fullPath = this.path + '/' + name,
            relPath = path.relative(this.gitRootPath, fullPath),
            self = this;

        gitHelper.fileType(this.gitBranch, this.gitRootPath, relPath, function(err, isDir) {
            if (err) return jsDAV_FS_Directory.getChild.call(self, name, cbgetchild);
            cbgetchild(null, isDir ?
                jsDAV_GIT_Directory.new(fullPath, self.gitRootPath, self.gitBranch) :
                jsDAV_GIT_File.new(fullPath, self.gitRootPath, self.gitBranch));
        });
    },

    getChildren: function(cbgetchildren) {
        var relPath = path.relative(this.gitRootPath, this.path),
            self = this;

        // read Git (branch) information first
        gitHelper.readDir(this.gitBranch, this.gitRootPath, relPath, function(err, treeInfo) {
            if (err) return cbgetchildren(err);

            var nodes = Object.getOwnPropertyNames(treeInfo).map(function(fileName) {
                var obj = treeInfo[fileName],
                    filePath = path.resolve(self.path, fileName);
                return obj.objectType == 'tree' ?
                    jsDAV_GIT_Directory.new(filePath, self.gitRootPath, self.gitBranch) :
                    jsDAV_GIT_File.new(filePath, self.gitRootPath, self.gitBranch);
            });

            // add file system information (for e.g. ignored files)
            Async.readdir(self.path)
                 .filter(function(file, next) {
                     var filename = path.relative(self.gitRootPath, file.path);
                     if (treeInfo.hasOwnProperty(filename))
                         return next(null, false);
                     fs.exists(file.path, function(exists) { next(null, exists) });
                 })
                 .stat()
                 .each(function(file, cbnextdirch) {
                     nodes.push(file.stat.isDirectory()
                         ? jsDAV_FS_Directory.new(file.path)
                         : jsDAV_FS_File.new(file.path)
                     );
                     cbnextdirch();
                 })
                 .end(function() {
                     nodes.sort(function(node1, node2) { return node1.path < node2.path ? -1 : 1; });
                     cbgetchildren(null, nodes);
                 });
        });
    },

    "delete": function(cbdel) {
        var relPath = path.relative(this.gitRootPath, this.path);
        gitHelper.unlink(this.gitBranch, this.gitRootPath, relPath, cbdel);
    },

    getLastModified: function(cbgetlm) {
        // TODO: cache some info in this.$stat
        var self = this,
            relPath = path.relative(this.gitRootPath, this.path);
        exec('git', ['log', '-1', '--format=\'%aD\'', this.gitBranch, '--', relPath], { cwd: this.gitRootPath }, function(err, stdout, stderr) {
            if (err)
                return cbgetlm(new Exc.FileNotFound('Directory at location ' + self.path + ' not found in ' + self.gitBranch));
            var dateStr = stdout.trimRight();
            cbgetlm(null, dateStr != '' ? new Date(dateStr) : new Date(0));
        });
    }

});