#!/usr/bin/env python3
"""Transfer an already verified bundle to a dedicated SSH directory and fetch it back.
Only backup data is transferred; repository working directories are never copied.
"""
import argparse
import json
from pathlib import Path
import re
import shlex
import subprocess
import uuid


def run(args, **kwargs):
    return subprocess.run(args, check=True, timeout=60, capture_output=True, text=True, **kwargs).stdout


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('host')
    parser.add_argument('bundle', type=Path)
    parser.add_argument('download', type=Path)
    parser.add_argument('receipt', type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.@-]*', args.host):
        raise ValueError('Invalid SSH host alias')
    if not (args.bundle / 'manifest.json').is_file() or args.download.exists() or args.receipt.exists():
        raise ValueError('Supply a complete bundle and new download/receipt paths')
    options = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ConnectionAttempts=1', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2']
    ssh = ['ssh', *options, args.host]
    identifier = uuid.uuid4().hex
    preparation = '''import json, pathlib, platform, os
p=pathlib.Path.home()/'.local/share/mem-brane/backup-rehearsals'/''' + repr(identifier) + '''
p.mkdir(parents=True,mode=0o700,exist_ok=False)
print(json.dumps({'hostname':platform.node(),'directory':str(p)}))
'''
    remote = json.loads(run([*ssh, 'python3 -'], input=preparation))
    remote_bundle = remote['directory'] + '/bundle'
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+', remote_bundle):
        raise ValueError('Remote home path requires unsupported escaping')
    run(['scp', *options, '-q', '-r', str(args.bundle.resolve()), args.host + ':' + remote_bundle])
    verifier = '''import hashlib,json,pathlib,sqlite3,sys
root=pathlib.Path(sys.argv[1]); manifest=json.loads((root/'manifest.json').read_text())
assert manifest['version']==1 and 'db.sqlite' in manifest['files']
for name,expected in manifest['files'].items():
 p=root/name
 assert p.resolve().is_relative_to(root.resolve()) and not p.is_symlink()
 with p.open('rb') as f:
  h=hashlib.sha256()
  for chunk in iter(lambda:f.read(1048576),b''): h.update(chunk)
 assert h.hexdigest()==expected, name
with sqlite3.connect((root/'db.sqlite').as_uri()+'?mode=ro',uri=True) as db:
 assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
 assert not db.execute('PRAGMA foreign_key_check').fetchall()
 assets=db.execute('SELECT count(*) FROM assets').fetchone()[0]
print(json.dumps({'files':len(manifest['files']),'assets':assets,'manifestSha256':hashlib.sha256((root/'manifest.json').read_bytes()).hexdigest()}))
'''
    checked = json.loads(run([*ssh, 'python3 - ' + shlex.quote(remote_bundle)], input=verifier))
    run(['scp', *options, '-q', '-r', args.host + ':' + remote_bundle, str(args.download.resolve())])
    receipt = {'hostAlias': args.host, **remote, 'remoteVerification': checked, 'download': str(args.download.resolve()), 'scope': 'backup bundle round trip; run rehearse-restore.ts on the download for HTTP proof'}
    args.receipt.write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt, indent=2))


if __name__ == '__main__':
    main()
