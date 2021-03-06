'use strict'

const BB = require('bluebird')

const cp = require('child_process')
const execFileAsync = BB.promisify(cp.execFile, {
  multiArgs: true
})
const finished = BB.promisify(require('mississippi').finished)
const LRU = require('lru-cache')
const optCheck = require('./opt-check')
const osenv = require('osenv')
const path = require('path')
const pinflight = require('promise-inflight')
const uniqueFilename = require('unique-filename')
const which = BB.promisify(require('which'))

const GOOD_ENV_VARS = new Set([
  'GIT_ASKPASS',
  'GIT_EXEC_PATH',
  'GIT_PROXY_COMMAND',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_SSL_CAINFO',
  'GIT_SSL_NO_VERIFY'
])

const GIT_ = 'GIT_'
let GITENV
function gitEnv () {
  if (GITENV) { return GITENV }
  const tmpDir = path.join(osenv.tmpdir(), 'pacote-git-template-tmp')
  const tmpName = uniqueFilename(tmpDir, 'git-clone')
  GITENV = {
    GIT_ASKPASS: 'echo',
    GIT_TEMPLATE_DIR: tmpName
  }
  Object.keys(process.env).forEach(k => {
    if (GOOD_ENV_VARS.has(k) || !k.startsWith(GIT_)) {
      GITENV[k] = process.env[k]
    }
  })
  return GITENV
}

let GITPATH
try {
  GITPATH = which.sync('git')
} catch (e) {}

module.exports.clone = fullClone
function fullClone (repo, committish, target, opts) {
  opts = optCheck(opts)
  const gitArgs = ['clone', '-q', repo, target]
  if (process.platform === 'win32') {
    gitArgs.push('--config', 'core.longpaths=true')
  }
  return execGit(gitArgs, {
    cwd: path.dirname(target)
  }, opts).then(() => {
    return execGit(['checkout', committish], {
      cwd: target
    })
  }).then(() => {
    return updateSubmodules(target, opts)
  }).then(() => headSha(target, opts))
}

module.exports.shallow = shallowClone
function shallowClone (repo, branch, target, opts) {
  opts = optCheck(opts)
  const gitArgs = ['clone', '--depth=1', '-q', '-b', branch, repo, target]
  if (process.platform === 'win32') {
    gitArgs.push('--config', 'core.longpaths=true')
  }
  return execGit(gitArgs, {
    cwd: target
  }, opts).then(() => {
    return updateSubmodules(target, opts)
  }).then(() => headSha(target, opts))
}

function updateSubmodules (localRepo, opts) {
  const gitArgs = ['submodule', 'update', '-q', '--init', '--recursive']
  return execGit(gitArgs, {
    cwd: localRepo
  }, opts)
}

function headSha (repo, opts) {
  opts = optCheck(opts)
  return execGit(['rev-parse', '--revs-only', 'HEAD'], {cwd: repo}, opts).spread(stdout => {
    return stdout.trim()
  })
}

const CARET_BRACES = '^{}'
const REVS = new LRU({
  max: 100,
  maxAge: 5 * 60 * 1000
})
module.exports.revs = revs
function revs (repo, opts) {
  opts = optCheck(opts)
  const cached = REVS.get(repo)
  if (cached) {
    return BB.resolve(cached)
  }
  return pinflight(`ls-remote:${repo}`, () => {
    return spawnGit(['ls-remote', '-h', '-t', repo], {
      env: gitEnv()
    }, opts).then(child => {
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', d => { stdout += d })
      child.stderr.on('data', d => { stderr += d })
      return finished(child).catch(err => {
        err.message = `Error while executing:\n${GITPATH} ls-remote -h -t ${repo}\n\n${stderr}\n${err.message}`
        throw err
      }).then(() => {
        return stdout.split('\n').reduce((revs, line) => {
          const split = line.split(/\s+/, 2)
          if (split.length < 2) { return revs }
          const sha = split[0].trim()
          const ref = split[1].trim().match(/(?:refs\/[^/]+\/)?(.*)/)[1]
          if (!ref) { return revs } // ???
          if (ref.endsWith(CARET_BRACES)) { return revs } // refs/tags/x^{} crap
          const type = refType(line)
          const doc = {sha, ref, type}

          revs.refs[ref] = doc
          // We can check out shallow clones on specific SHAs if we have a ref
          if (revs.shas[sha]) {
            revs.shas[sha].push(ref)
          } else {
            revs.shas[sha] = [ref]
          }

          if (type === 'tag') {
            const match = ref.match(/v?(\d+\.\d+\.\d+)$/)
            if (match) {
              revs.versions[match[1]] = doc
            }
          }

          return revs
        }, {versions: {}, 'dist-tags': {}, refs: {}, shas: {}})
      }).then(revs => {
        if (revs.refs.HEAD) {
          const HEAD = revs.refs.HEAD
          Object.keys(revs.versions).forEach(v => {
            if (v.sha === HEAD.sha) {
              revs['dist-tags'].HEAD = v
              if (!revs.refs.latest) {
                revs['dist-tags'].latest = revs.refs.HEAD
              }
            }
          })
        }
        REVS.set(repo, revs)
        return revs
      })
    })
  })
}

module.exports._exec = execGit
function execGit (gitArgs, gitOpts, opts) {
  opts = optCheck(opts)
  return checkGit().then(gitPath => {
    return execFileAsync(gitPath, gitArgs, mkOpts(gitOpts, opts))
  })
}

module.exports._spawn = spawnGit
function spawnGit (gitArgs, gitOpts, opts) {
  opts = optCheck(opts)
  return checkGit().then(gitPath => {
    return cp.spawn(gitPath, gitArgs, mkOpts(gitOpts, opts))
  })
}

function mkOpts (_gitOpts, opts) {
  const gitOpts = {
    env: gitEnv()
  }
  if (+opts.uid && !isNaN(opts.uid)) {
    gitOpts.uid = +opts.uid
  }
  if (+opts.gid && !isNaN(opts.gid)) {
    gitOpts.gid = +opts.gid
  }
  Object.assign(gitOpts, _gitOpts)
  return gitOpts
}

function checkGit () {
  if (!GITPATH) {
    const err = new Error('No git binary found in $PATH')
    err.code = 'ENOGIT'
    return BB.reject(err)
  } else {
    return BB.resolve(GITPATH)
  }
}

const REFS_TAGS = 'refs/tags/'
const REFS_HEADS = 'refs/heads/'
const HEAD = 'HEAD'
function refType (ref) {
  return ref.indexOf(REFS_TAGS) !== -1
  ? 'tag'
  : ref.indexOf(REFS_HEADS) !== -1
  ? 'branch'
  : ref.endsWith(HEAD)
  ? 'head'
  : 'other'
}
