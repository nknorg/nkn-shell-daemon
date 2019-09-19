const fs = require('fs');
const os = require('os');
const argv = require('yargs').argv;
const { exec, execSync } = require('child_process');

const nknClient = require('nkn-multiclient');
const nknWallet = require('nkn-wallet');
const randomBytes = require('nkn-wallet/lib/crypto/tools').randomBytes;

const pingInterval = 20000;

const baseDir = '/etc/nshd/';
const walletFile = baseDir + 'wallet.json';
const passwordFile = baseDir + 'wallet.pswd';
const authorizedPkFile = baseDir + 'authorized_pubkeys';

const identifier = argv.identifier || "";
const syncExecTimeout = argv.syncexectimeout || 5000;
const asyncExecTimeout = argv.asyncexectimeout || 0;
const logCmd = argv.logcmd;

if (!fs.existsSync(baseDir)){
  fs.mkdirSync(baseDir);
  console.log("Create directory", baseDir);
}

var wallet;
try {
  let walletJson = fs.readFileSync(walletFile).toString();
  let password;
  try {
    password = fs.readFileSync(passwordFile).toString();
  } catch (e) {
    console.error("Open password file error:", e.message);
    process.exit(1);
  }
  try {
    wallet = nknWallet.loadJsonWallet(walletJson, password);
  } catch (e) {
    console.error("Parse wallet error:", e);
    process.exit(1);
  }
} catch (e) {
  let password
  try {
    password = fs.readFileSync(passwordFile).toString();
  } catch (e) {
    password = Buffer.from(randomBytes(32)).toString('base64');
    fs.writeFileSync(passwordFile, password);
    console.log("Create password and save to file", passwordFile);
  }
  wallet = nknWallet.newWallet(password);
  fs.writeFileSync(walletFile, wallet.toJSON());
  console.log("Create wallet and save to file", walletFile);
}

var authorizedPk = [];
var authorizedPkRaw = [];
try {
  authorizedPkRaw = fs.readFileSync(authorizedPkFile).toString().split('\n');
} catch (e) {
  fs.writeFileSync(authorizedPkFile, "");
  console.log("Create authorized pubkeys file", authorizedPkFile);
}
for (var i in authorizedPkRaw) {
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
      console.error("Error parsing uid from", s[1]);
      continue
    }
  }

  if (s.length > 2) {
    au.gid = parseInt(s[2]);
    if (isNaN(au.gid)) {
      console.error("Error parsing gid from", s[2]);
      continue
    }
  }

  authorizedPk = authorizedPk.concat(au);
}

function getAuthorizedUser(src) {
  let s = src.split('.');
  let pk = s[s.length-1];
  for (var au of authorizedPk) {
    if (au.addr && au.addr === src) {
      return au;
    }
    if (au.pk && au.pk === pk) {
      return au;
    }
  }
  return null;
}

const client = nknClient({
  seed: wallet.getSeed(),
  identifier: identifier,
});

client.on('connect', () => {
  console.log('Listening at', client.addr);
  for (var i = 0; i < client.clients.length; i++) {
    let c = client.clients[i];
    setInterval(function () {
      try {
        c.ws && c.ws.ping();
      } catch (e) {
        console.warn("Ping error:", e);
      }
    }, pingInterval);
  }
});

client.on('message', async (src, payload, payloadType, encrypt) => {
  if (!encrypt) {
    console.log('Received unencrypted msg from', src);
    return false;
  }

  let au = getAuthorizedUser(src);
  if (!au) {
    console.log('Received msg from unauthorized sender', src);
    return false;
  }

  if (payloadType === nknClient.PayloadType.BINARY) {
    console.log('Received msg with wrong payload type from', src);
    return false;
  }

  let msg = JSON.parse(payload);

  if (msg.timestamp && (Date.now() - Date.parse(msg.timestamp)) > 60000) {
    return false;
  }

  let cmd = msg.cmd || msg.content;
  let options = {
    uid: au.uid,
    gid: au.gid,
  };

  console.log('Execute cmd' + (logCmd ? ' ' + cmd : ''), 'from', src);

  if (msg.execSync) {
    options.timeout = msg.execTimeout || syncExecTimeout;
    let stdout, stderr;
    try {
      stdout = execSync(cmd, options).toString();
    } catch (e) {
      stderr = e.stderr ? e.stderr.toString() : e.error;
    }
    return JSON.stringify({
      stdout,
      stderr,
    });
  } else {
    options.timeout = msg.execTimeout || asyncExecTimeout;
    exec(cmd, options, (error, stdout, stderr) => {
      let res;
      if (msg.content) {
        res = {
          content: stdout || stderr,
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
      client.send(src, JSON.stringify(res), { msgHoldingSeconds: 0 }).catch(e => {
        console.error("Send msg error:", e);
      });
    });
    return;
  }
});
