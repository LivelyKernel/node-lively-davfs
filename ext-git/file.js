var jsDAV_FS_File = require('jsDAV/lib/DAV/backends/fs/file');

var exec = require('child_process').execFile;
var path = require('path');
var fs = require('fs');
var gitHelper = require('lively-git-helper');

// copied from jsDAV/lib/DAV/backends/fs/tree
var Exc = require('jsDAV/lib/shared/exceptions');

var jsDAV_GIT_File = module.exports = jsDAV_FS_File.extend({

    initialize: function(path, gitRootPath, gitBranch) {
        this.path = path;
        this.gitRootPath = gitRootPath;
        this.gitBranch = gitBranch;
    },

    get: function(cbfileget) {
        // TODO: cache file content in this.$buffer
        var relPath = path.relative(this.gitRootPath, this.path);
        gitHelper.readFile(this.gitBranch, this.gitRootPath, relPath, cbfileget);
    },

    getStream: undefined, // delete getStream from jsDAV_FS_File

    put: function(data, enc, cbput) {
        var relPath = path.relative(this.gitRootPath, this.path);
        gitHelper.writeFile(this.gitBranch, this.gitRootPath, relPath, data, enc || 'utf8', cbput);
    },

    putStream: undefined, // delete putStream from jsDAV_FS_File

    "delete": function(cbfiledel) {
        var relPath = path.relative(this.gitRootPath, this.path);
        gitHelper.unlink(this.gitBranch, this.gitRootPath, relPath, cbfiledel);
    },

    // getETag: function(cbfsgetetag) {
    //     cbfsgetetag(null, null);
    // },

    getSize: function(cbgetsize) {
        // TODO: cache some info in this.$stat
        var self = this,
            relPath = path.relative(this.gitRootPath, this.path);
        gitHelper.fileSize(this.gitBranch, this.gitRootPath, relPath, function(err, size) {
            if (err)
                return cbgetsize(new Exc.FileNotFound('File at location ' + self.path + ' not found in ' + self.gitBranch));
            cbgetsize(null, size);
        });
    },

    getLastModified: function(cbgetlm) {
        // TODO: cache some info in this.$stat
        var self = this,
            relPath = path.relative(this.gitRootPath, this.path);
        gitHelper.lastModified(this.gitBranch, this.gitRootPath, relPath, function(err, date) {
            if (err)
                return cbgetlm(new Exc.FileNotFound('Directory at location ' + self.path + ' not found in ' + self.gitBranch));
            cbgetlm(null, date);
        });
    }
    
});