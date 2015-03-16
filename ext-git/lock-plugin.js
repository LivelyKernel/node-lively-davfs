var jsDAV_ServerPlugin = require('jsDAV/lib/DAV/plugin');
var jsDAV_GIT_Tree = require('./tree');
var Exc = require('jsDAV/lib/shared/exceptions');

var gitHelper = require('lively-git-helper');

var jsDAV_GIT_Lock_Plugin = module.exports = jsDAV_ServerPlugin.extend({

    name: 'gitFSLock',

    initialize: function(handler) {
        this.handler = handler;
        handler.addEventListener('beforeMethod', this.beforeMethod.bind(this));
    },

    // only checks PUT requests and blocks them if 
    //     1) there uri matches a versioned/to version file (e.g. no HTML file) AND
    //     2) they are made against the default branch OR
    //        the file system directly
    beforeMethod: function(e, method) {
        var tree = this.handler.server.tree;
        if (Object.getPrototypeOf(tree) != jsDAV_GIT_Tree) // should only be active on Git trees
            return e.next();

        var uri = this.handler.getRequestUri();

        if (method != 'PUT') // only checks file changes
            return e.next();

        if (tree.currentBranch === undefined) // no branch specified
            return e.next(new Exc.Locked({ uri: uri }));

        gitHelper.isIgnored(this.basePath, uri, function(err, ignored) {
            if (err && err.code != 'NONGIT') return e.next(err);

            if (ignored || (err && err.code == 'NONGIT') || (tree.defaultBranch != tree.currentBranch))
                e.next();
            else
                e.next(new Exc.Locked({ uri: uri }));
        });
    }

});