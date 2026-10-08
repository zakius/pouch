import subprocess, json, pathlib, platform, statistics, sys
version = json.loads(pathlib.Path('src/manifest.json').read_text())['version']
out = {'commit': subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(), 'environment': {'platform':platform.platform(),'bun':subprocess.check_output(['bun','--version'],text=True).strip()}, 'host': 'Bun with mocked browser APIs; cold process import to first getArticles response, not extension/browser startup', 'samples': {}}
for target,root in [('firefox','dist/unpackaged'),('chromium','dist/chromium/pouch')]:
    files=list(pathlib.Path(root).rglob('*.js'))
    bg=next(pathlib.Path(root).glob('background/*.js'))
    samples=[]
    for i in range(10):
        p=subprocess.check_output(['bun','scripts/measure-startup.ts',str(bg.resolve())],text=True)
        samples.append(json.loads(p.splitlines()[-1])['startupMs'])
    out['samples'][target]={'jsBytes':sum(f.stat().st_size for f in files),'backgroundBytes':bg.stat().st_size,'packageBytes':pathlib.Path('dist/packages/'+(f'pouch-{version}.zip' if target=='firefox' else f'pouch-chromium-{version}.zip')).stat().st_size,'startupMs':samples,'medianMs':statistics.median(samples)}
pathlib.Path(sys.argv[1]).write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps(out,indent=2))
