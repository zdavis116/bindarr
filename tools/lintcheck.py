import re, subprocess, os

node = os.path.expanduser('~/.cache/hermes-node20/node-v20.20.2-linux-x64/bin')
env = dict(os.environ, PATH=node + ':' + os.environ['PATH'])

def lint():
    r = subprocess.run(['npm', 'run', 'lint', '--prefix', 'frontend'],
                       capture_output=True, text=True, env=env)
    return [' '.join(l.split()) for l in r.stdout.split('\n') if ' error ' in l]

errs = lint()
print(f'lint errors after the swap: {len(errs)}')
for e in errs[:20]:
    print(' ', e[:95])
