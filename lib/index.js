"use strict";

var _fs = _interopRequireDefault(require("fs"));

var _os = _interopRequireDefault(require("os"));

var _yargs = _interopRequireDefault(require("yargs"));

var _nodePty = require("node-pty");

var _nknMulticlient = _interopRequireDefault(require("nkn-multiclient"));

var _nknWallet = _interopRequireDefault(require("nkn-wallet"));

var _crypto = require("crypto");

var _child_process = require("child_process");

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

let argv = _yargs.default.command('$0', 'start nshd').command('addr', 'show addr').option('base-dir', {
  alias: 'b',
  describe: 'set base directory',
  type: 'string',
  default: '/etc/nshd/'
}).option('wallet', {
  alias: 'w',
  describe: 'set wallet file path, default to `baseDir`/wallet.json',
  type: 'string'
}).option('password-file', {
  alias: 'p',
  describe: 'set wallet password file, default to `baseDir`/wallet.pswd',
  type: 'string'
}).option('authorized-pk-file', {
  alias: 'auth',
  describe: 'set authorized file, default to `baseDir`/authorized_pubkeys',
  type: 'string'
}).option('shell', {
  alias: 's',
  describe: 'set shell application path, default to bash or powershell.exe (on windows)',
  type: 'string'
}).option('session', {
  alias: 'sess',
  describe: 'nshd will save prev cmd',
  type: 'boolean',
  default: false
}).option('identifier', {
  alias: 'id',
  describe: 'set identifier',
  type: 'string',
  default: ''
}).option('sync-exec-timeout', {
  alias: ['sto'],
  describe: 'set sync exec timeout in ms',
  type: 'number',
  default: 5000
}).option('async-exec-timeout', {
  alias: ['ato'],
  describe: 'set async exec timeout in ms',
  type: 'number',
  default: 0
}).option('log-cmd', {
  alias: 'lc',
  describe: 'show executed cmd in console',
  type: 'boolean',
  default: false
}).help('help').alias('h', 'help').wrap(Math.min(120, _yargs.default.terminalWidth())).argv;

const isWindows = _os.default.platform() === 'win32';
const pingInterval = 20000;
const showAddr = argv._[0] === 'addr';
const baseDir = argv.baseDir + (argv.baseDir.endsWith('/') ? '' : '/');
const walletFile = argv.wallet || baseDir + 'wallet.json';
const passwordFile = argv.passwordFile || baseDir + 'wallet.pswd';
const authorizedPkFile = argv.authorizedPkFile || baseDir + 'authorized_pubkeys';
const shell = argv.shell || (isWindows ? 'powershell.exe' : 'bash');
const session = argv.session;
const identifier = argv.identifier;
const syncExecTimeout = argv.syncExecTimeout;
const asyncExecTimeout = argv.asyncExecTimeout;
const logCmd = argv.logCmd;

if (!_fs.default.existsSync(baseDir)) {
  _fs.default.mkdirSync(baseDir);

  console.log('Create directory', baseDir);
}

let wallet;

try {
  let walletJson = _fs.default.readFileSync(walletFile).toString();

  let password;

  try {
    password = _fs.default.readFileSync(passwordFile).toString();
  } catch (e) {
    console.error('Open password file error:', e.message);
    process.exit(1);
  }

  try {
    wallet = _nknWallet.default.loadJsonWallet(walletJson, password);
  } catch (e) {
    console.error('Parse wallet error:', e);
    process.exit(1);
  }
} catch (e) {
  let password;

  try {
    password = _fs.default.readFileSync(passwordFile).toString();
  } catch (e) {
    password = Buffer.from((0, _crypto.randomBytes)(32)).toString('base64');

    _fs.default.writeFileSync(passwordFile, password);

    console.log('Create password and save to file', passwordFile);
  }

  wallet = _nknWallet.default.newWallet(password);

  _fs.default.writeFileSync(walletFile, wallet.toJSON());

  console.log('Create wallet and save to file', walletFile);
}

if (showAddr) {
  console.log((identifier ? identifier + '.' : '') + wallet.getPublicKey());
  process.exit(0);
}

let authorizedPk = [];
let authorizedPkRaw = [];

try {
  authorizedPkRaw = _fs.default.readFileSync(authorizedPkFile).toString().split('\n');
} catch (e) {
  _fs.default.writeFileSync(authorizedPkFile, '');

  console.log('Create authorized pubkeys file', authorizedPkFile);
}

for (let i in authorizedPkRaw) {
  let s = authorizedPkRaw[i].match(/\S+/g) || [];

  if (s.length == 0) {
    continue;
  }

  let au = {};

  if (s[0].includes('.')) {
    au.addr = s[0];
  } else {
    au.pk = s[0];
  }

  if (s.length > 1) {
    au.uid = parseInt(s[1]);

    if (isNaN(au.uid)) {
      console.error('Error parsing uid from', s[1]);
      continue;
    }
  }

  if (s.length > 2) {
    au.gid = parseInt(s[2]);

    if (isNaN(au.gid)) {
      console.error('Error parsing gid from', s[2]);
      continue;
    }
  }

  authorizedPk = authorizedPk.concat(au);
}

function getAuthorizedUser(src) {
  let s = src.split('.');
  let pk = s[s.length - 1];

  for (let au of authorizedPk) {
    if (au.addr && au.addr === src) {
      return au;
    }

    if (au.pk && au.pk === pk) {
      return au;
    }
  }

  return null;
}

const client = (0, _nknMulticlient.default)({
  seed: wallet.getSeed(),
  identifier: identifier
});
let ptyProcess;
let sessionSrc;
client.on('connect', () => {
  console.log('Listening at', client.addr);

  for (let i = 0, length = client.clients.length; i < length; i++) {
    let c = client.clients[i];
    setInterval(function () {
      try {
        c.ws && c.ws.ping && c.ws.ping();
      } catch (e) {
        console.warn('Websocket ping error:', e);
      }
    }, pingInterval);
  }

  let lastUpdateTime = new Date();
  setInterval(async function () {
    try {
      await client.send(client.addr, '', {
        msgHoldingSeconds: 0
      });
      lastUpdateTime = new Date();
    } catch (e) {
      console.warn('Multiclient ping error:', e);

      if (new Date().getTime() - lastUpdateTime.getTime() > pingInterval * 3) {
        console.log('Multiclient keepalive timeout, trying to reconnect...');

        for (let i = 0, length = client.clients.length; i < length; i++) {
          client.clients[i].reconnect();
        }
      }
    }
  }, pingInterval);

  if (session && !ptyProcess) {
    let sessionBuffer = '';
    let res;
    ptyProcess = (0, _nodePty.spawn)(shell, [], {
      name: 'xterm-color',
      cols: 120,
      rows: 30,
      cwd: isWindows ? process.env.USERPROFILE : process.env.HOME,
      env: process.env
    });
    ptyProcess.onData(data => {
      sessionBuffer += data;
    });

    function flushSession() {
      if (sessionBuffer.length > 0) {
        res = {
          stdout: sessionBuffer
        };
        sessionBuffer = '';
        client.send(sessionSrc, JSON.stringify(res), {
          msgHoldingSeconds: 0
        }).catch(e => {
          console.error("Send msg error:", e);
        });
        setTimeout(flushSession, 10);
      } else {
        setTimeout(flushSession, 25);
      }
    }

    flushSession();
  }
});
client.on('message', async (src, payload, payloadType, encrypt) => {
  if (!encrypt) {
    console.log('Received unencrypted msg from', src);
    return false;
  }

  if (src === client.addr) {
    return;
  }

  let au = getAuthorizedUser(src);

  if (!au) {
    console.log('Received msg from unauthorized sender', src);
    return false;
  }

  if (payloadType === _nknMulticlient.default.PayloadType.BINARY) {
    console.log('Received msg with wrong payload type from', src);
    return false;
  }

  let msg = JSON.parse(payload);

  if (msg.timestamp && Date.now() - Date.parse(msg.timestamp) > 60000) {
    return false;
  }

  let cmd = msg.cmd || msg.content;
  let options = {
    uid: au.uid,
    gid: au.gid
  };
  console.log('Execute cmd' + (logCmd ? ' ' + cmd : ''), 'from', src);

  if (msg.execSync) {
    options.timeout = msg.execTimeout || syncExecTimeout;
    let stdout, stderr;

    try {
      stdout = (0, _child_process.execSync)(cmd, options).toString();
    } catch (e) {
      stderr = e.stderr ? e.stderr.toString() : e.error;
    }

    return JSON.stringify({
      stdout,
      stderr
    });
  } else {
    options.timeout = msg.execTimeout || asyncExecTimeout;

    if (session && !msg.content) {
      sessionSrc = src;
      ptyProcess.write(cmd);
    } else {
      (0, _child_process.exec)(cmd, options, (error, stdout, stderr) => {
        let res;

        if (msg.content) {
          res = {
            content: "```\n" + (stdout || stderr) + "\n```",
            contentType: "text",
            timestamp: new Date().toUTCString(),
            isPrivate: true
          };
        } else {
          res = {
            stdout,
            stderr
          };
        }

        client.send(src, JSON.stringify(res), {
          msgHoldingSeconds: 0
        }).catch(e => {
          console.error("Send msg error:", e);
        });
      });
    }
  }
});