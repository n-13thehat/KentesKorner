import re

with open('batocera/kente-server.py', encoding='utf-8') as f:
    src = f.read()

m = re.search(r"__version__\s*=\s*'([^']+)'", src)
print('__version__ definition:', m.group(0) if m else 'NOT FOUND')

# Find every 'version': ... in the file
for i, line in enumerate(src.splitlines(), 1):
    if "'version'" in line or '"version"' in line:
        print(f"  Line {i}: {line.strip()}")
