import fs from 'fs'
import os from 'os'
import yargs from 'yargs'
import { spawn } from 'node-pty'
import nkn from 'nkn-sdk'
import { randomBytes } from 'crypto'
import { exec, execSync } from 'child_process'
import WebSocket from 'isomorphic-ws'

let argv = yargs
  .command('$0', 'start nshd')
  .command('addr', 'show addr')
  .option('base-dir', {
    alias: 'b',
    describe: 'set base directory',
    type: 'string',
    default: '/etc/nshd/',
  })
  .option('wallet', {
    alias: 'w',
    describe: 'set wallet file path, default to `baseDir`/wallet.json',
    type: 'string',
  })
  .option('password-file', {
    alias: 'p',
    describe: 'set wallet password file, default to `baseDir`/wallet.pswd',
    type: 'string',
  })
  .option('authorized-pk-file', {
    alias: 'auth',
    describe: 'set authorized file, default to `baseDir`/authorized_pubkeys',
    type: 'string',
  })
  .option('shell', {
    alias: 's',
    describe: 'set shell application path, default to bash or powershell.exe (on windows)',
    type: 'string',
  })
  .option('session', {
    alias: 'sess',
    describe: 'nshd will save prev cmd',
    type: 'boolean',
    default: true,
  })
  .option('identifier', {
    alias: 'id',
    describe: 'set identifier',
    type: 'string',
    default: '',
  })
  .option('sync-exec-timeout', {
    alias: ['sto'],
    describe: 'set sync exec timeout in ms',
    type: 'number',
    default: 5000,
  })
  .option('async-exec-timeout', {
    alias: ['ato'],
    describe: 'set async exec timeout in ms',
    type: 'number',
    default: 0,
  })
  .option('log-cmd', {
    alias: 'lc',
    describe: 'show executed cmd in console',
    type: 'boolean',
    default: false,
  })
  .option('must-keepalive', {
    describe: 'nshd will exit if keepalive failed',
    type: 'boolean',
    default: false,
  })
  .help('help')
  .alias('h', 'help')
  .wrap(Math.min(120, yargs.terminalWidth()))
  .argv

const isWindows = os.platform() === 'win32'
const pingInterval = 20000
const forcePingInterval = 60000
const ptyCols = 120
const ptyRows = 30
const sessionFlushIntervalInUse = 10
const sessionFlushIntervalIdle = 25

const showAddr = argv._[0] === 'addr'

const baseDir = argv.baseDir + (argv.baseDir.endsWith('/') ? '' : '/')
const walletFile = argv.wallet || baseDir + 'wallet.json'
const passwordFile = argv.passwordFile || baseDir + 'wallet.pswd'
const authorizedPkFile = argv.authorizedPkFile || baseDir + 'authorized_pubkeys'
const shell = argv.shell || (isWindows ? 'powershell.exe' : 'bash')
const session = argv.session
const identifier = argv.identifier
const syncExecTimeout = argv.syncExecTimeout
const asyncExecTimeout = argv.asyncExecTimeout
const logCmd = argv.logCmd

if (!fs.existsSync(baseDir)) {
  fs.mkdirSync(baseDir)
  console.log('Create directory', baseDir)
}

let wallet
try {
  let walletJson = fs.readFileSync(walletFile).toString()
  let password
  try {
    password = fs.readFileSync(passwordFile).toString().split('\n')[0]
  } catch (e) {
    console.error('Open password file error:', e.message)
    process.exit(1)
  }
  try {
    wallet = nkn.Wallet.fromJSON(walletJson, { password })
  } catch (e) {
    console.error('Parse wallet error:', e)
    process.exit(1)
  }
} catch (e) {
  let password
  try {
    password = fs.readFileSync(passwordFile).toString()
  } catch (e) {
    password = Buffer.from(randomBytes(32)).toString('base64')
    fs.writeFileSync(passwordFile, password)
    console.log('Create password and save to file', passwordFile)
  }
  wallet = new nkn.Wallet({ password })
  fs.writeFileSync(walletFile, JSON.stringify(wallet))
  console.log('Create wallet and save to file', walletFile)
}
if (showAddr) {
  console.log((identifier ? identifier + '.' : '') + wallet.getPublicKey())
  process.exit(0)
}

let authorizedPk = []
let authorizedPkRaw = []
try {
  authorizedPkRaw = fs.readFileSync(authorizedPkFile).toString().split('\n')
} catch (e) {
  fs.writeFileSync(authorizedPkFile, '')
  console.log('Create authorized pubkeys file', authorizedPkFile)
}

authorizedPk = parseAuthorizedPk(authorizedPkRaw)

fs.watchFile(authorizedPkFile, () => {
  console.log('Reload authorized pubkeys file');
  authorizedPkRaw = fs.readFileSync(authorizedPkFile).toString().split('\n')
  authorizedPk = parseAuthorizedPk(authorizedPkRaw)
})

function parseAuthorizedPk(raw) {
  let parsed = []
  for (let i in raw) {
    let s = raw[i].match(/\S+/g) || []

    if (s.length == 0) {
      continue
    }

    let au = {}

    if (s[0].includes('.')) {
      au.addr = s[0]
    } else {
      au.pk = s[0]
    }

    if (s.length > 1) {
      au.uid = parseInt(s[1])
      if (isNaN(au.uid)) {
        console.error('Error parsing uid from', s[1])
        continue
      }
    }

    if (s.length > 2) {
      au.gid = parseInt(s[2])
      if (isNaN(au.gid)) {
        console.error('Error parsing gid from', s[2])
        continue
      }
    }

    parsed = parsed.concat(au)
  }
  return parsed
}

function getAuthorizedUser(src) {
  let s = src.split('.')
  let pk = s[s.length - 1]
  for (let au of authorizedPk) {
    if (au.addr && au.addr === src) {
      return au
    }
    if (au.pk && au.pk === pk) {
      return au
    }
  }
  return null
}

const client = new nkn.MultiClient({
  originalClient: true,
  seed: wallet.getSeed(),
  identifier: identifier,
})

class Session {
  constructor(client, remoteAddr, options) {
    this.client = client
    this.remoteAddr = remoteAddr
    this.outputBuffer = ''
    this.exit = false
    this.ptyProcess = spawn(shell, [], Object.assign({
      name: 'xterm-color',
      cols: ptyCols,
      rows: ptyRows,
      cwd: isWindows ? process.env.USERPROFILE : process.env.HOME,
      env: process.env,
    }, options))

    this.ptyProcess.onData(data => {
      this.outputBuffer += data
    })

    this.ptyProcess.onExit(() => {
      this.exit = true
      delete sessions[this.remoteAddr]
    })

    this.flushSession = async () => {
      if (this.outputBuffer.length > 0) {
        try {
          let res = {
            stdout: this.outputBuffer
          };
          await this.client.send(this.remoteAddr, JSON.stringify(res), { noReply: true })
          this.outputBuffer = ''
        } catch (e) {
          console.error("Send msg error:", e)
        }
        if (!this.exit) {
          this.flushTimeout = setTimeout(this.flushSession, sessionFlushIntervalInUse)
        }
      } else {
        if (!this.exit) {
          this.flushTimeout = setTimeout(this.flushSession, sessionFlushIntervalIdle)
        }
      }
    }

    this.flushSession()
  }

  write(cmd) {
    this.ptyProcess.write(cmd)
  }

  resize(size) {
    this.ptyProcess.resize(size.cols, size.rows)
  }
}

let sessions = {}

client.onConnect(() => {
  console.log('Listening at', client.addr)

  for (let c of Object.values(client.clients)) {
    setInterval(function () {
      try {
        c.ws && c.ws.readyState === WebSocket.OPEN && c.ws.ping && c.ws.ping()
      } catch (e) {
        console.warn('Websocket ping error:', e)
      }
    }, pingInterval)
  }

  let lastUpdateTime = new Date()
  setInterval(async () => {
    try {
      await client.send(client.addr, '')
      lastUpdateTime = new Date()
    } catch (e) {
      console.warn('Multiclient ping error:', e)
      let t = new Date().getTime() - lastUpdateTime.getTime()
      if (argv.mustKeepalive && t > pingInterval * 5) {
        process.exit(1)
      }
      if (t > pingInterval * 3) {
        console.log('Multiclient keepalive timeout, trying to reconnect...')
        for (let c of Object.values(client.clients)) {
          c._reconnect()
        }
      }
    }
  }, pingInterval)

  let lastForceUpdateTime = new Date()
  let tempClient
  setInterval(async () => {
    if (tempClient) {
      tempClient.close().catch((e) => {
        console.error('Close temp client error:', e);
      })
    }
    let tempIdentifier = nkn.util.randomBytesHex(4)
    if (identifier) {
      tempIdentifier += '.' + identifier
    }
    tempClient = new nkn.MultiClient({
      originalClient: true,
      seed: wallet.getSeed(),
      identifier: tempIdentifier,
    });
    tempClient.onConnect(() => {
      setTimeout(async () => {
        try {
          await tempClient.send(client.addr, '')
          lastForceUpdateTime = new Date()
        } catch (e) {
          console.warn('Force ping error:', e)
          let t = new Date().getTime() - lastForceUpdateTime.getTime()
          if (argv.mustKeepalive && t > forcePingInterval * 5) {
            process.exit(1)
          }
          if (t > forcePingInterval * 3) {
            console.log('Force keepalive timeout, trying to reconnect...')
            for (let c of Object.values(client.clients)) {
              c._reconnect()
            }
          }
        }
        tempClient.close().catch((e) => {
          console.error('Close temp client error:', e);
        })
        tempClient = null
      }, 3000);
    })
  }, forcePingInterval)
})

client.onMessage(async ({ src, payload, payloadType, isEncrypted }) => {
  if (!isEncrypted) {
    console.log('Received unencrypted msg from', src)
    return false
  }

  if (src.endsWith(client.getPublicKey()) && !payload) {
    return
  }

  let au = getAuthorizedUser(src)
  if (!au) {
    console.log('Received msg from unauthorized sender', src)
    return false
  }

  if (payloadType !== nkn.pb.payloads.PayloadType.TEXT) {
    console.log('Received msg with wrong payload type from', src)
    return false
  }

  let msg = JSON.parse(payload)

  if (msg.timestamp && (Date.now() - Date.parse(msg.timestamp)) > 60000) {
    return false
  }

  let options = {
    uid: au.uid,
    gid: au.gid,
  }

  if (session && msg.resize) {
    if (!sessions[src]) {
      sessions[src] = new Session(client, src, options)
    }
    sessions[src].resize(msg.resize)
    console.log('Resize to', msg.resize, 'from', src)
  }

  let cmd = msg.cmd || msg.content
  if (!cmd) {
    return false
  }

  console.log('Execute cmd' + (logCmd ? ' ' + cmd : ''), 'from', src)

  if (msg.execSync) {
    options.timeout = msg.execTimeout || syncExecTimeout
    let stdout, stderr
    try {
      stdout = execSync(cmd, options).toString()
    } catch (e) {
      stderr = e.stderr ? e.stderr.toString() : e.error
    }
    return JSON.stringify({
      stdout,
      stderr,
    })
  } else {
    options.timeout = msg.execTimeout || asyncExecTimeout
    if (session && !msg.content) {
      if (!sessions[src]) {
        sessions[src] = new Session(client, src, options)
      }
      sessions[src].write(cmd)
    } else {
      exec(cmd, options, async (error, stdout, stderr) => {
        let res;
        if (msg.content) { // d-chat protocol
          res = {
            content: "```\n" + (stdout || stderr) + "\n```",
            contentType: "text",
            timestamp: new Date().toUTCString(),
            isPrivate: true,
          }
        } else {
          res = {
            stdout,
            stderr,
          }
        }
        try {
          await client.send(src, JSON.stringify(res), { noReply: true })
        } catch (e) {
          console.error("Send msg error:", e)
        }
      });
    }
  }
})
