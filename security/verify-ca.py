#!/usr/bin/env python3
"""Inspect an image without starting its application; fail closed before push."""
import argparse, hashlib, json, pathlib, re, subprocess, sys
TARGET='86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b'
def run(args):
    return subprocess.run(args,check=True,capture_output=True).stdout

def certificates(pem):
    result=[]
    for block in re.findall(rb'-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----',pem,re.S):
        p=subprocess.run(['openssl','x509','-noout','-subject','-issuer','-nameopt','RFC2253','-fingerprint','-sha256'],input=block,check=True,capture_output=True).stdout.decode()
        identity=dict(line.split('=',1) for line in p.strip().splitlines())
        fingerprint=identity['sha256 Fingerprint'].replace(':','').lower()
        is_g3=bool(re.search(r'(?:^|,)CN=emSign ECC Root CA - G3(?:,|$)',identity['subject']))
        if is_g3 and fingerprint!=TARGET: raise RuntimeError('Unexpected G3 fingerprint')
        result.append({'fingerprint':fingerprint,'subject':identity['subject'],'g3':is_g3})
    if not result: raise RuntimeError('Empty CA bundle')
    return result

def inspect(image,platform):
    prefix=['docker','run','--rm','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--platform',platform]
    bundle=run(prefix+['--entrypoint','cat',image,'/etc/ssl/certs/ca-certificates.crt'])
    certs=certificates(bundle)
    return {'image':image,'platform':platform,'id':run(['docker','image','inspect','--format','{{.Id}}',image]).decode().strip(),'count':len(certs),'g3':any(c['g3'] for c in certs),'certificates':certs,'bundle_sha256':hashlib.sha256(bundle).hexdigest()}

p=argparse.ArgumentParser(); p.add_argument('image');p.add_argument('--platform',default='linux/amd64');p.add_argument('--baseline');p.add_argument('--output',required=True);a=p.parse_args()
try:
    current=inspect(a.image,a.platform)
    if a.baseline:
        old=json.loads(pathlib.Path(a.baseline).read_text())
        current['old_image']=old['image']; current['old_count']=old['count'];current['old_g3']=old['g3'];current['delta']=current['count']-old['count']
        if current['g3']: raise RuntimeError('G3 still trusted')
        old_roots={c['fingerprint']:c['subject'] for c in old['certificates']}
        new_roots={c['fingerprint']:c['subject'] for c in current['certificates']}
        current['removed_roots']=[old_roots[x] for x in sorted(old_roots.keys()-new_roots.keys())]
        current['added_roots']=[new_roots[x] for x in sorted(new_roots.keys()-old_roots.keys())]
        current['verified']=True
    pathlib.Path(a.output).write_text(json.dumps(current,indent=2)+'\n')
    print(json.dumps({k:v for k,v in current.items() if k!='certificates'}))
except Exception as e:
    print(f'CA verification failed: {e}',file=sys.stderr);sys.exit(1)
