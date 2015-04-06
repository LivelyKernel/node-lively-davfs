var jsDAV_FS_Tree = require('jsDAV/lib/DAV/backends/fs/tree');
var jsDAV_FS_File = require('jsDAV/lib/DAV/backends/fs/file');
var jsDAV_FS_Directory = require('jsDAV/lib/DAV/backends/fs/directory');
var jsDAV_GIT_File = require('./file');
var jsDAV_GIT_Directory = require('./directory');

var exec = require('child_process').exec;
var path = require('path');
var fs = require('fs');
var gitHelper = require('lively-git-helper');

// copied from jsDAV/lib/DAV/backends/fs/tree
var Exc = require('jsDAV/lib/shared/exceptions');
var Util = require('jsDAV/lib/shared/util');


var jsDAV_GIT_Tree = module.exports = jsDAV_FS_Tree.extend({

    initialize: function(basePath, defaultBranch) {
        this.basePath = basePath;
        this.defaultBranch = defaultBranch || 'master';
        this.currentBranch = this.defaultBranch;
    },

    getNodeForPath: function(name, cbtree) {
        var realPath = this.getRealPath(name),
            // nicePath = this.stripSandbox(realPath),
            self = this;

        if (this.currentBranch == undefined)
            return jsDAV_FS_Tree.getNodeForPath.call(this, name, cbtree);

        // if (!this.insideSandbox(realPath))
        //     return cbtree(new Exc.Forbidden("You are not allowed to access " + nicePath));

        function findGitPathIncremental(pathParts, callback) {
            gitHelper.gitPath(pathParts.join(path.sep), function(err, repoBase) {
                if (err) {
                    if (err.code == 'NOTADIR' && pathParts.length > 0)
                        return findGitPathIncremental(pathParts.slice(0, -1), callback);
                    else
                        return callback(err);
                }
                callback(null, repoBase);
            });
        }

        findGitPathIncremental(realPath.split(path.sep), function(err, repoBase) {
            if (err) return jsDAV_FS_Tree.getNodeForPath.call(self, name, cbtree);
            var relName = path.relative(repoBase, realPath);
            gitHelper.fileType(self.currentBranch, repoBase, relName, function(err, isDir) {
                if (!err) {
                    cbtree(null, isDir ?
                        jsDAV_GIT_Directory.new(realPath, repoBase, self.currentBranch) :
                        jsDAV_GIT_File.new(realPath, repoBase, self.currentBranch));
                } else if (err.code == 'SYMLINK') {
                    gitHelper.readFile(self.currentBranch, repoBase, relName, function(err, buf) {
                        var linkedPath = path.resolve(path.dirname(relName), buf.toString()),
                            relPath = path.relative(self.basePath, linkedPath);
                        if (relPath.substr(0, 2) == '..')
                            fs.stat(linkedPath, function(err, stat) { // copied from jsDAV_FS_Tree.getNodeForPath
                                if (!Util.empty(err))
                                    return cbtree(new Exc.FileNotFound('File at location ' + name + ' not found'));
                                cbtree(null, stat.isDirectory() ?
                                    jsDAV_FS_Directory.new(linkedPath) :
                                    jsDAV_FS_File.new(linkedPath));
                            });
                        else
                            self.getNodeForPath(relPath, cbtree);
                    });
                } else
                    gitHelper.isIgnored(repoBase, relName, function(err, ignored) {
                        if (err || ignored)
                            return jsDAV_FS_Tree.getNodeForPath.call(self, name, cbtree);
                        cbtree(new Exc.FileNotFound('File at location ' + relName + ' not found in "' + self.currentBranch + "'"));
                    });
            });
        });
    },

    setCurrentBranch: function(branchName) {
        this.currentBranch = branchName;
    },

    copy: function(source, destination, cbcopy) {
        var self = this;

        if (this.currentBranch == undefined)
            return jsDAV_FS_Tree.copy.call(this, source, destination, cbcopy);

        // if (!this.insideSandbox(destination)) {
        //     return cbfsrcopy(new Exc.Forbidden("You are not allowed to copy to " +
        //         this.stripSandbox(destination)));
        // }

        // make sure it exists in GIT ... otherwise do FS copy
        gitHelper.fileType(this.currentBranch, this.basePath, source, function(err) {
            if (err) return jsDAV_FS_Tree.copy.call(self, source, destination, cbcopy);
            gitHelper.copy(self.currentBranch, self.basePath, source, destination, cbcopy);
        });
    },

    // realCopy: undefined, // delete realCopy from jsDAV_FS_Tree

    move: function(source, destination, cbmove) {
        var self = this;

        if (this.currentBranch == undefined)
            return jsDAV_FS_Tree.move.call(this, source, destination, cbmove);

        // if (!this.insideSandbox(destination)) {
        //     return cbfsmove(new Exc.Forbidden("You are not allowed to move to " +
        //         this.stripSandbox(destination)));
        // }

        // make sure it exists in GIT ... otherwise do FS move
        gitHelper.fileType(this.currentBranch, this.basePath, source, function(err) {
            if (err) return jsDAV_FS_Tree.move.call(self, source, destination, cbmove);
            gitHelper.rename(self.currentBranch, self.basePath, source, destination, cbmove);
        });
    }

});