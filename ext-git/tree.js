var jsDAV_FS_Tree = require('jsDAV/lib/DAV/backends/fs/tree');
var jsDAV_FS_File = require('jsDAV/lib/DAV/backends/fs/file');
var jsDAV_FS_Directory = require('jsDAV/lib/DAV/backends/fs/directory');
var jsDAV_GIT_File = require('./file');
var jsDAV_GIT_Directory = require('./directory');

var exec = require('child_process').exec;
var fs = require('fs');
var gitHelper = require('./helper');

// copied from jsDAV/lib/DAV/backends/fs/tree
var Exc = require('jsDAV/lib/shared/exceptions');
var Util = require('jsDAV/lib/shared/util');


var jsDAV_GIT_Tree = module.exports = jsDAV_FS_Tree.extend({

    initialize: function(basePath, defaultBranch) {
        this.basePath = basePath;
        this.defaultBranch = defaultBranch || 'master';
        this.currentBranch = this.defaultBranch;
    },

    getNodeForPath: function(path, cbtree) {
        var realPath = this.getRealPath(path),
            nicePath = this.stripSandbox(realPath),
            self = this;

        // if (!this.insideSandbox(realPath))
        //     return cbtree(new Exc.Forbidden("You are not allowed to access " + nicePath));

        gitHelper.fileType(this.currentBranch, this.basePath, path, function(err, isDir) {
            if (err) return jsDAV_FS_Tree.getNodeForPath.call(self, path, cbtree);
            cbtree(null, isDir ?
                jsDAV_GIT_Directory.new(realPath, self.basePath, self.currentBranch) :
                jsDAV_GIT_File.new(realPath, self.basePath, self.currentBranch));
        });
    },

    setCurrentBranch: function(branchName) {
        this.currentBranch = branchName || this.defaultBranch;
    },

    copy: function(source, destination, cbcopy) {
        var self = this;

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

    realCopy: undefined, // delete realCopy from jsDAV_FS_Tree

    move: function(source, destination, cbmove) {
        var self = this;

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