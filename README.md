# NKN Shell Daemon

NKN shell daemon (nshd) is a Node.js application that uses
[nkn-multiclient-js](https://github.com/nknorg/nkn-multiclient-js) to listen for
incoming shell command from authenticated users, executes, and send back results
through nkn-client. It is similar to sshd but has a few fundamental difference:

1. Network transparent: NKN address is used instead of IP address, so host
machine can freely change IP address without being affected.

2. Higher security: Communication is through nkn-client where public key is part
of the nkn address, so everything is end to end encrypted without the need to
fetch or trust public key separately. This protocol eliminates man-in-the-middle
(MITM) attack caused by mismatch of address and public key.

3. No open port: Host machine running nshd does not need to open any port or
have a public IP address. All connections are outbound instead of inbound. This
makes nshd even more secure and convenient.

4. Cross platform compatibility: It just takes a few lines of code to send
commands and receive results in any language supporting NKN client SDK.

## Get Started

The fastest way to get started is to run `nshd` with `--session` argument and
use one of the following client:

* [http://nsh.nkn.org](http://nsh.nkn.org) (source: [nkn-shell-client-xterm](https://github.com/nknorg/nkn-shell-client-xterm))

* [d-chat](http://gitlab.com/losnappas/d-chat) private message

But you still need to add your client public key to `authorized_pubkeys`, see
the next section.

## Configurations

### Address and Identity

When nshd starts, it will read `/etc/nshd/wallet.json` and
`/etc/nshd/wallet.pswd` to get NKN wallet file and password. If wallet file does
not exist, it will generate a random wallet and password and save to that
location. The wallet file is compatible with [NKN
node](https://github.com/nknorg/nkn) and wallet SDK.

After nshd gets the wallet, it will print out its NKN address in stdout where
you can send command to and receive results from. By default it's just the
wallet public key, but you can choose the identifier part of the NKN address
using `--identifier=xxx` argument when launching nshd.

### Permission Control

Similar to sshd, nshd will read authorized public keys or addresses from
`/etc/nshd/authorized_pubkeys`. Only message from these public keys will be
handled. Content of `authorized_pubkeys` should follow the scheme:

```
authorized_public_key_or_addr_1 [uid] [gid]
authorized_public_key_or_addr_2 [uid] [gid]
```

If a public key is given, then all NKN addresses from that public key (with any
identifier) will be accepted. If an address is given, then only that specific
address will be accepted. Both uid and gid are optional and controls the user
and group of the process used to execute commands. If uid and gid are not given,
user/group where nshd process belongs to will be used.

## Sending Commands and Receiving Results

Sending commands is as simple as using
[nkn-multiclient-js](https://github.com/nknorg/nkn-multiclient-js) or other
client implementations to send a JSON message to nshd's listening NKN address.
The JSON message can have the following fields:

* `cmd` <string> Shell command to execute.

* `execSync` <boolean> If true, results will be returned in message reply,
  otherwise results will be sent in a separate message. Default: `false`.

* `execTimeout` <number> In milliseconds the maximum amount of time the process
  is allowed to run. Default to `5000` if `execSync` is true, or `0` (unlimited)
  if not. The default value can be changed by `--syncexectimeout=xxx` and
  `--asyncexectimeout=xxx` argument when launching nshd.

The execution results will be returned as reply if `execTimeout` is true, or as
a separate message if `execTimeout` is false. The results is a JSON message with
the following fields:

* `stdout` <string> The stdout of the process running the command.

* `stderr` <string> The stderr of the process running the command.
