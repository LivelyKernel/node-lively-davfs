"use strict"

var async = require("async");
var util = require("util");
var Url = require("url");
var Path = require("path");

var Repository = require('./repository');
var d = require('./domain');
var EventEmitter = require("events").EventEmitter;

var DavHandler = require('jsDAV/lib/DAV/handler');
var FsTree = require('jsDAV/lib/DAV/backends/fs/tree');
var defaultPlugins = require("jsDAV/lib/DAV/server").DEFAULT_PLUGINS;


function LivelyFsHandler(options) {
    EventEmitter.call(this);
    this.initialize(options);
}

util._extend(LivelyFsHandler.prototype, EventEmitter.prototype);

util._extend(LivelyFsHandler.prototype, d.bindMethods({

    initialize: function(options) {
        options = options || {};
        options.fs = options.fs || process.cwd();
        options.excludedDirectories = options.excludedDirectories || ['.svn', '.git', 'node_modules'];
        options.excludedFiles = options.excludedFiles || ['.DS_Store'];
        options.includedFiles = options.includedFiles || undefined/*allow all*/;
        this.enableVersioning = options.enableVersioning === undefined || !!options.enableVersioning; // default: true
        this.enableRewriting = this.enableVersioning && !!options.enableRewriting; // default: false
        this.resetDatabase = !!options.resetDatabase;
        this.repository = new Repository(options);
        this.timemachineSettings = (function tmSetup(tmOptions) {
            if (!tmOptions) return null;
            var path = tmOptions.path;
            if (!path) return null;
            if (path[0] !== '/') path = '/' + path;
            if (path[path.length-1] !== '/') path += '/';
            return {path: path};
        })(options.timemachine || {path: '/timemachine/'});
    },

    registerWith: function(app, server, thenDo) {
        if (!server) this.emit('error', new Error('livelydavfs request handler needs server!'));
        this.server = server;
        server.davHandler = this;
        var deactivated = !this.enableVersioning;
        var resetDB = this.resetDatabase;
        var handler = this, repo = handler.repository;
        async.series([
            this.patchServer.bind(this, server),
            function(next) {
                deactivated && console.log('no versioning...!');
                if (deactivated) next();
                else repo.start(resetDB, next);
            },
            function(next) {
                server.on('close', repo.close.bind(repo));
                server.on('close', function() { handler.server = null; });
                next();
            }
        ], function(err) {
            if (err) console.error(err);
            console.log('LivelyFsHandler registerWith done');
            thenDo && thenDo(err);
        });
        return this;
    },

    patchServer: function(server, thenDo) {
        // this is what jsDAV expects...
        server.tree = FsTree.new(this.repository.getRootDirectory());
        server.tmpDir = './tmp'; // httpPut writes tmp files
        server.options = {};
        // for showing dir contents
        server.plugins = {
            browser: defaultPlugins.browser};
        if (this.enableVersioning) {
            server.plugins.livelydav = this.repository.getDAVPlugin();
        }
        // https server has slightly different interface
        if (!server.baseUri) server.baseUri = '/';
        if (!server.getBaseUri) server.getBaseUri = function() { return this.baseUri };
        thenDo(null);
    },

    handleRequest: function(req, res, next) {
        if (this.isTimemachineRequest(req)) {
            this.handleTimemachineRequest(req, res, next);
        } else if (this.isRewrittenCodeRequest(req)) {
            // FIXME: temporary divert files named DBG_*.js
            this.handleRewrittenCodeRequest(req, res, next);
        } else {
            new DavHandler(this.server, req, res);
        }
    },

    // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
    // timemachine support
    isTimemachineRequest: function(req) {
        if (!this.timemachineSettings) return false;
        var tmPath = this.timemachineSettings.path;
        return req.url.indexOf(tmPath) === 0;
    },

    makeDateAndTime: function(versionString) {
        versionString = decodeURIComponent(versionString);
        return new Date(versionString);
    },

    handleTimemachineRequest: function(req, res, next) {
        // req.url is something like '/timemachine/2010-08-07%2015%3A33%3A22/foo/bar.js'
        // tmPath = '/timemachine/'
        if (req.method.toLowerCase() !== 'get') {
            res.status(400).end('timemachine request to ' + req.url + ' not supported.');
            return;
        }
        var tmPath = this.timemachineSettings.path,
            repo = this.repository,
            versionedPath = req.url.slice(tmPath.length),
            version = versionedPath.slice(0, versionedPath.indexOf('/'));
        if (!version) {
            res.status(400).end('cannot read version from path: ' + req.url);
            return;
        }
        var path = versionedPath.slice(version.length);
        if (path[0] === '/') path = path.slice(1);
        var ts = this.makeDateAndTime(version);
        console.log('timemachine into %s, %sing path %s', ts, req.method, path);
        this.repository.getRecords({
            paths: [path],
            older: ts,
            attributes: ['version', 'date', 'author', 'content'],
            limit: 1
        }, function(err, records) {
            if (err) { res.status(500).end(String(err)); return; }
            if (!records.length) { res.status(404).end(util.format('Nothing stored for %s at %s', path, ts)); return; }
            res.setHeader('content-type', '*/*;charset=utf8')
            var content = records[records.length-1].content;
            res.end(content);
        });
    },

    // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
    // rewritten code support
    isRewrittenCodeRequest: function(req) {
        if (!this.enableRewriting) return false;
        var filename = Path.basename(Url.parse(req.url).pathname);
        return !!filename.match(/^DBG_(.*)\.[Jj][Ss][Mm]?$/) || (req.url == '/core/lively/ast/BootstrapDebugger.js');
    },

    handleRewrittenCodeRequest: function(req, res, next) {
        if (req.method.toLowerCase() !== 'get') {
            res.status(400).end('rewritten code request to ' + req.url + ' not supported.');
            return;
        }
        if (req.url == '/core/lively/ast/BootstrapDebugger.js') {
            this.handleRewrittenCodeMapRequest(req, res, next);
            return;
        }
        if (Path.extname(req.url).toLowerCase() == '.jsm') {
            this.handleRewrittenSourceMapRequest(req, res, next);
            return;
        }
        var lvfs = this.repository.fs,
            repo = this.repository;
        var path = Url.parse(req.url).pathname;
        var filename = Path.basename(path).match(/^DBG_(.*\.[Jj][Ss])$/)[1];
        path = Path.join(Path.dirname(path), filename).substr(1);
        console.log('%sing rewritten code for %s', req.method, path);
        this.repository.getRecords({
            paths: [path],
            attributes: ['version', 'date', 'author', 'content', 'sourcemap'],
            rewritten: true,
            newest: true
        }, function(err, records) {
            function handleReadResult(err, content) {
                if (!err) {
                    res.status(200).end(content);
                    content = content.toString();
                    var record = {
                        change: 'rewrite',
                        version: undefined,
                        author: 'unknown',
                        date: new Date().toISOString().replace(/[0-9]{3}Z/, '000Z'),
                        content: content,
                        path: path,
                        stat: fs.statSync(Path.join(lvfs.rootDirectory, path))
                    };
                    repo.pendingChangeQueue.push({
                        record: record,
                        canBeCommitted: function() { return true; },
                        startTime: Date.now()
                    });
                    repo.commitPendingChanges();
                } else {
                    console.error('error reading file %s:', content, err);
                    res.status(404).end(util.format('Nothing rewritten stored for %s', path));
                }
            }

            if (err) { res.status(500).end(String(err)); return; }
            if (!records.length || (records[0].content == null)) {
                console.log('Nothing rewritten stored for %s', path);
                // try to read the file from the filesystem, rewrite it, put it in the db and ship it
                fs.readFile(Path.join(lvfs.rootDirectory, path), handleReadResult);
                return;
            }
            res.setHeader('content-type', 'application/javascript;charset=utf8')
            var content = records[0].content;
            if (records[0].sourcemap != null)
                content += '\n\n//# sourceMappingURL=DBG_' + filename + 'm';
            res.end(content);
        });
    },

    handleRewrittenCodeMapRequest: function(req, res, next) {
        // TODO: Determine necessary modules for world load,
        //       the rest of the AST registry can be lazily be loaded from the server later
        var files = [
            // 'core/lib/lively-libs-debug.js',
            'core/lively/Migration.js',
            'core/lively/JSON.js',
            'core/lively/lang/Object.js',
            'core/lively/lang/Function.js',
            'core/lively/lang/String.js',
            'core/lively/lang/Array.js',
            'core/lively/lang/Number.js',
            'core/lively/lang/Date.js',
            'core/lively/lang/Worker.js',
            'core/lively/lang/LocalStorage.js',
            'core/lively/defaultconfig.js',
            'core/lively/Base.js',
            'core/lively/ModuleSystem.js',
            'core/lively/Traits.js',
            'core/lively/DOMAbstraction.js',
            'core/lively/IPad.js',
            'core/lively/LogHelper.js',
            'core/lively/lang/Closure.js',
            'core/lively/lang/UUID.js',
            //
            'core/lively/bindings/Core.js',
            'core/lively/persistence/Serializer.js',
            'core/lively/Main.js',
            'core/lively/net/WebSockets.js',
            'core/cop/Layers.js',
            'core/lively/OldModel.js',
            'core/lively/Data.js',
            'core/lively/Network.js',
            // neccessary to be able to load everything else dynamically
            'core/lively/store/Interface.js'
        ];
        this.repository.getRecords({
            paths: files,
            attributes: ['ast', 'registry_id', 'registry_additions'],
            rewritten: true,
            newest: true
        }, function(err, records) {
            var code = [
                lively.ast.Rewriting.findNodeByAstIndexBaseDef,
                lively.ast.Rewriting.createClosureBaseDef,
                lively.ast.Rewriting.UnwindExceptionBaseDef,
                "window.LivelyDebuggingASTRegistry=[];"
            ];
            records.each(function(record) {
                code.push('window.LivelyDebuggingASTRegistry[' + record.registry_id + ']=' + record.ast + ';')
                var moreRegistry = JSON.parse(record.registry_additions);
                moreRegistry.each(function(entry, idx) {
                    code.push('window.LivelyDebuggingASTRegistry[' + (record.registry_id + idx + 1) + ']=' + JSON.stringify(entry) + ';');
                });
            });
            res.setHeader('content-type', 'application/javascript;charset=utf8')
            res.end(code.join('\n'));
        });
    },

    handleRewrittenSourceMapRequest: function(req, res, next) {
        var path = Url.parse(req.url).pathname;
        var filename = Path.basename(path).match(/^DBG_(.*\.[Jj][Ss])[Mm]$/)[1];
        path = Path.join(Path.dirname(path), filename).substr(1);
        console.log('%sing source map for %s', req.method, path);
        this.repository.getRecords({
            paths: [path],
            attributes: ['sourcemap'],
            rewritten: true,
            newest: true
        }, function(err, records) {
            if (err) { res.status(500).end(String(err)); return; }
            if (!records.length || (records[0].sourcemap == null)) {
                res.status(400).end();
                return;
            }
            res.setHeader('content-type', 'application/json;charset=utf8')
            res.end(records[0].sourcemap);
        });
    }

}));

// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
// exports
module.exports = LivelyFsHandler;