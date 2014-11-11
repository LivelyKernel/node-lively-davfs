var exec = require('child_process').execFile,
    spawn = require('child_process').spawn,
    path = require('path'),
    async = require('async');

var START_COMMIT_MESSAGE = '[LV-CHANGESET-START]',
    TMP_COMMIT_MESSAGE = '[LV-CHANGESET-STASH]',
    FILE_TEMPLATE = {
        fileMode: '100644', // default filemode
        objectType: 'blob',
    },
    DIRECTORY_TEMPLATE = {
        fileMode: '040000', // default dirmode
        objectType: 'tree'
    };


function treeFromString(str, withoutPath) {
    var objects = str.trimRight().split('\n'),
        withoutPath = !!withoutPath;

    if (objects.length == 1 && objects[0] == '') // no directory content
        objects = [];

    return objects.reduce(function(tree, objLine) {
        // ls-tree returns lines in the format of:
        // <mode> SP <type> SP <object> TAB <file> NL
        // (see http://git-scm.com/docs/git-ls-tree)
        var info = objLine.match(/^([0-9]+) (tree|blob) ([0-9a-f]+)\t(.*)$/);
        if (!info) // should not happen!!
            throw new Error('Found weird Git ls-tree info (unparseable): ' + objLine);
        var filename = withoutPath ? path.basename(info[4]) : info[4];
        tree[filename] = {
            fileMode: info[1],
            objectType: info[2],
            objectHash: info[3]
        };
        return tree;
    }, {});
}

function stringFromTree(tree) {
    var lines = Object.getOwnPropertyNames(tree).map(function(filename) {
        var info = tree[filename];
        return info.fileMode + ' ' + info.objectType + ' ' + info.objectHash + '\t' + filename;
    });
    return lines.join('\n');
}



function ensureBranch(branch, workingDir, callback) {
    exec('git', ['branch', '--list', branch], { cwd: workingDir }, function(err, stdout, stderr) {
        if (err) return callback(err);
        if (stdout.trim() != '') return callback(); // branch already existing

        // Create a branch but also include everything that is
        // currently pending (uncommited changes, new files, etc.)
        exec('git', ['add', '-A'], { cwd: workingDir }, function(err, stdout, stderr) {
            if (err) return callback(err);
            exec('git', ['commit', '-a', '--allow-empty', '-m', START_COMMIT_MESSAGE], { cwd: workingDir }, function(err, stdout, stderr) {
                if (err) return callback(err);
                exec('git', ['branch', branch], { cwd: workingDir }, function(err, stdout, stderr) {
                    if (err) return callback(err);
                    exec('git', ['reset', '--mixed', 'HEAD^1'], { cwd: workingDir }, function(err, stdout, stderr) {
                        callback(err);
                    });
                });
            });
        });
    });
}

function getFileType(branch, workingDir, fileName, callback) {
    exec('git', ['cat-file', '-t', branch + ':' + fileName], { cwd: workingDir }, function(err, stdout, stderr) {
        if (err) return callback(err);
        callback(null, stdout.trimRight() == 'tree');
    });
}

function createHashObject(workingDir, buffer, encoding, callback) {
    var process = spawn('git', ['hash-object', '-t', 'blob', '-w', '--stdin'], { cwd: workingDir }),
        stdout = '',
        stderr = '';
    process.stdout.on('data', function(buffer) {
        stdout += buffer.toString();
    });
    process.stderr.on('data', function(buffer) {
        stderr += buffer.toString();
    });
    process.on('close', function(code) {
        if (code == 0)
            callback(null, { fileHash: stdout.trimRight() } );
        else
            callback(new Error(stderr));
    });
    process.stdin.end(buffer, encoding);
}

function getParentHash(branch, workingDir, fileInfo, callback) {
    exec('git', ['log', '--pretty=%H %s', '-n', '1', branch], { cwd: workingDir }, function(err, stdout, stderr) {
        if (err) return callback(err);
        var lineInfo = stdout.trimRight().match(/^([0-9a-f]+) (.*)$/);
        fileInfo.parent = lineInfo[1];
        var parentMessage = lineInfo[2];
        if (parentMessage == TMP_COMMIT_MESSAGE) {
            // need to ammend last commit
            fileInfo.stash = fileInfo.parent;
            // get real parent's hash
            exec('git', ['log', '--pretty=%H', '-n', '1', fileInfo.stash + '^1'], { cwd: workingDir }, function(err, stdout, stderr) {
                if (err) return callback(err);
                fileInfo.parent = stdout.trimRight();
                callback(null, fileInfo);
            });
        } else
            callback(null, fileInfo);
    });
}

function getCurrentTrees(workingDir, fileName, fileInfo, callback) { // parent's or stash' trees
    var pathParts = fileName.split(path.sep);
    pathParts.pop();
    var pathes = pathParts.reduce(function(pathes, part) {
        pathes.unshift(path.join(pathes[0], part) + '/');
        return pathes;
    }, ['']);

    async.map(pathes, function(path, callback) {
        exec('git', ['ls-tree', (fileInfo.stash || fileInfo.parent), path], { cwd: workingDir }, function(err, stdout, stderr) {
            if (err) return callback(err);
            callback(null, treeFromString(stdout, true));
        });
    }, function(err, results) {
        if (err) return callback(err);
        fileInfo.treeInfos = results;
        callback(null, fileInfo);
    });
}

function copyFileHash(fileName, fileInfo, callback) {
    var info = fileInfo.treeInfos[0][path.basename(fileName)];
    if (!(info && info.objectHash))
        return callback(new Error('Could not find object to copy (source)!'));
    fileInfo.fileHash = info.objectHash;
    callback(null, fileInfo);
}

function injectHashObjectIntoTree(fileName, fileInfo, callback) {
    var info = fileInfo.treeInfos[0][path.basename(fileName)] = JSON.parse(JSON.stringify(FILE_TEMPLATE)); // ... clone FILE_TEMPLATE
    info.objectHash = fileInfo.fileHash;
    callback(null, fileInfo);
}

function injectEmptyDirIntoTree(workingDir, dirName, fileInfo, callback) {
    var process = spawn('git', ['mktree'], { cwd: workingDir }),
        stdout = '',
        stderr = '';
    process.stdout.on('data', function(buffer) {
        stdout += buffer.toString();
    });
    process.stderr.on('data', function(buffer) {
        stderr += buffer.toString();
    });
    process.on('close', function(code) {
        if (code != 0)
            return callback(new Error(stderr));
        var info = fileInfo.treeInfos[0][path.basename(dirName)] = JSON.parse(JSON.stringify(DIRECTORY_TEMPLATE)); // ... clone
        info.objectHash = stdout.trimRight() // empty tree hash
        callback(null, fileInfo);
    });
    process.stdin.end();
}

function removeObjectFromTree(fileName, fileInfo, callback) {
    delete fileInfo.treeInfos[0][path.basename(fileName)];
    callback(null, fileInfo);
}

function createTrees(workingDir, fileName, fileInfo, callback) {
    var pathParts = fileName.split(path.sep);

    async.reduce(fileInfo.treeInfos, null, function(subHash, treeInfo, callback) {
        var subDir = pathParts.pop();
        console.log(subDir, subHash);
        if (subHash != null) {
            treeInfo[subDir] = treeInfo[subDir] || JSON.parse(JSON.stringify(DIRECTORY_TEMPLATE)); // ... or clone empty dir
            treeInfo[subDir].objectHash = subHash; // update tree with updated hash
        }
        var process = spawn('git', ['mktree'], { cwd: workingDir }),
            stdout = '',
            stderr = '';
        process.stdout.on('data', function(buffer) {
            stdout += buffer.toString();
        });
        process.stderr.on('data', function(buffer) {
            stderr += buffer.toString();
        });
        process.on('close', function(code) {
            if (code != 0)
                return callback(new Error(stderr));
                var newHash = stdout.trimRight();
            callback(null, newHash);
        });
        process.stdin.end(stringFromTree(treeInfo));
    }, function(err, result) {
        if (err) return callback(err);
        fileInfo.rootTree = result;
        callback(null, fileInfo);
    });
}

function createCommit(workingDir, commitInfo, fileInfo, callback) {
    exec('git', ['commit-tree', fileInfo.rootTree, '-p', fileInfo.parent, '-m', TMP_COMMIT_MESSAGE], { cwd: workingDir, env: commitInfo }, function(err, stdout, stderr) {
        if (err) return callback(err);
        fileInfo.commit = stdout.trimRight();
        callback(null, fileInfo);
    });
}

function updateBranch(branch, workingDir, fileInfo, callback) {
    exec('git', ['update-ref', 'refs/heads/' + branch, fileInfo.commit], { cwd: workingDir }, function(err, stdout, stderr) {
        if (err) return callback(err);
        callback(null, fileInfo);
    });
}

module.exports = {

    fileType: function(branch, workingDir, path, callback) {
        async.waterfall([
            ensureBranch.bind(null, branch, workingDir),
            getFileType.bind(null, branch, workingDir, path)
        ], callback);
    },

    readDir: function(branch, workingDir, path, callback) {
        exec('git', ['ls-tree', branch + ':' + path], { cwd: workingDir }, function(err, stdout, stderr) {
            if (err) return callback(err);
            callback(null, treeFromString(stdout));
        });
    },

    writeFile: function(branch, workingDir, path, buffer, encoding, callback) {
        var commitInfo = { // FIXME: use real commit info
            GIT_AUTHOR_NAME: 'John Doe',
            GIT_AUTHOR_EMAIL: 'John Doe <john@me.doe>',
            GIT_COMMITTER_NAME: 'Lively ChangeSets',
            GIT_COMMITTER_EMAIL: 'unknown-user@lively-web.local'
        };

        async.waterfall([
            ensureBranch.bind(null, branch, workingDir),
            createHashObject.bind(null, workingDir, buffer, encoding),
            getParentHash.bind(null, branch, workingDir),
            getCurrentTrees.bind(null, workingDir, path),
            injectHashObjectIntoTree.bind(null, path),
            createTrees.bind(null, workingDir, path),
            createCommit.bind(null, workingDir, commitInfo),
            updateBranch.bind(null, branch, workingDir),
            function(fileInfo, callback) {
                callback(); // remove fileInfo from callback call
            }
        ], callback);
    },

    mkDir: function(branch, workingDir, path, callback) {
        var commitInfo = { // FIXME: use real commit info
            GIT_AUTHOR_NAME: 'John Doe',
            GIT_AUTHOR_EMAIL: 'John Doe <john@me.doe>',
            GIT_COMMITTER_NAME: 'Lively ChangeSets',
            GIT_COMMITTER_EMAIL: 'unknown-user@lively-web.local'
        };

        async.waterfall([
            ensureBranch.bind(null, branch, workingDir),
            getParentHash.bind(null, branch, workingDir, {}),
            getCurrentTrees.bind(null, workingDir, path),
            injectEmptyDirIntoTree.bind(null, workingDir, path),
            createTrees.bind(null, workingDir, path),
            createCommit.bind(null, workingDir, commitInfo),
            updateBranch.bind(null, branch, workingDir),
            function(fileInfo, callback) {
                callback(); // remove fileInfo from callback call
            }
        ], callback);
    },

    unlink: function(branch, workingDir, path, callback) {
        var commitInfo = { // FIXME: use real commit info
            GIT_AUTHOR_NAME: 'John Doe',
            GIT_AUTHOR_EMAIL: 'John Doe <john@me.doe>',
            GIT_COMMITTER_NAME: 'Lively ChangeSets',
            GIT_COMMITTER_EMAIL: 'unknown-user@lively-web.local'
        };

        async.waterfall([
            ensureBranch.bind(null, branch, workingDir),
            getParentHash.bind(null, branch, workingDir, {}),
            getCurrentTrees.bind(null, workingDir, path),
            removeObjectFromTree.bind(null, path),
            createTrees.bind(null, workingDir, path),
            createCommit.bind(null, workingDir, commitInfo),
            updateBranch.bind(null, branch, workingDir),
            function(fileInfo, callback) {
                callback(); // remove fileInfo from callback call
            }
        ], callback);
    },

    copy: function(branch, workingDir, source, destination, callback) {
        var commitInfo = { // FIXME: use real commit info
            GIT_AUTHOR_NAME: 'John Doe',
            GIT_AUTHOR_EMAIL: 'John Doe <john@me.doe>',
            GIT_COMMITTER_NAME: 'Lively ChangeSets',
            GIT_COMMITTER_EMAIL: 'unknown-user@lively-web.local'
        };

        async.waterfall([
            ensureBranch.bind(null, branch, workingDir),
            getParentHash.bind(null, branch, workingDir, {}),
            getCurrentTrees.bind(null, workingDir, source),
            copyFileHash.bind(null, source),
            getCurrentTrees.bind(null, workingDir, destination),
            injectHashObjectIntoTree.bind(null, destination),
            createTrees.bind(null, workingDir, destination),
            createCommit.bind(null, workingDir, commitInfo),
            updateBranch.bind(null, branch, workingDir),
            function(fileInfo, callback) {
                callback(); // remove fileInfo from callback call
            }
        ], callback);
    },

    rename: function(branch, workingDir, source, destination, callback) {
        async.waterfall([
            this.copy.bind(this, branch, workingDir, source, destination),
            this.unlink.bind(this, branch, workingDir, source),
        ], callback);
    },

    isIgnored: function(workingDir, path, callback) {
        exec('git', ['check-ignore', '-q', path], { cwd: workingDir }, function(err) {
            if (!err)
                callback(null, true);
            else if (!err.killed && err.code == 1) {
                callback(null, false);
            } else
                callback(err);
        });
    }

}