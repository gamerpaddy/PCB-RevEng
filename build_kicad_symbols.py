#!/usr/bin/env python3
# Parse every KiCad .kicad_sym library into a compact symbol catalog for reveng.
import os, sys, json, glob, time

SYM_DIR = r"C:\Program Files\KiCad\10.0\share\kicad\symbols"

def tokenize(s):
    toks = []
    i, n = 0, len(s)
    while i < n:
        c = s[i]
        if c == '(' or c == ')':
            toks.append(c); i += 1
        elif c.isspace():
            i += 1
        elif c == '"':
            i += 1; buf = []
            while i < n:
                c = s[i]
                if c == '\\':
                    buf.append(s[i+1]); i += 2; continue
                if c == '"':
                    i += 1; break
                buf.append(c); i += 1
            toks.append(('str', ''.join(buf)))
        else:
            buf = []
            while i < n and not s[i].isspace() and s[i] not in '()':
                buf.append(s[i]); i += 1
            toks.append(('sym', ''.join(buf)))
    return toks

def parse(toks):
    pos = 0
    def rd():
        nonlocal pos
        t = toks[pos]; pos += 1
        if t == '(':
            lst = []
            while toks[pos] != ')':
                lst.append(rd())
            pos += 1
            return lst
        return t
    return rd()

def head(node):
    return node[0][1] if (node and isinstance(node[0], tuple) and node[0][0] == 'sym') else None

def kids(node, tag):
    return [c for c in node if isinstance(c, list) and head(c) == tag]

def count_pins(node):
    c = 0
    for x in node:
        if isinstance(x, list):
            if head(x) == 'pin': c += 1
            else: c += count_pins(x)
    return c

def get_prop(sym, name):
    for p in kids(sym, 'property'):
        if len(p) >= 3 and isinstance(p[1], tuple) and p[1][1] == name:
            return p[2][1] if isinstance(p[2], tuple) else ''
    return None

def main():
    files = sorted(glob.glob(os.path.join(SYM_DIR, '*.kicad_sym')))
    entries = []
    t0 = time.time()
    for fi, path in enumerate(files):
        lib = os.path.splitext(os.path.basename(path))[0]
        with open(path, 'r', encoding='utf-8') as fh:
            txt = fh.read()
        root = parse(tokenize(txt))
        # base pin counts within this lib, for resolving (extends ...)
        local = {}   # name -> {ref,pins,units,desc,kw,extends}
        for sym in kids(root, 'symbol'):
            name = sym[1][1] if isinstance(sym[1], tuple) else None
            if not name: continue
            ext = None
            ec = kids(sym, 'extends')
            if ec: ext = ec[0][1][1]
            pins = count_pins(sym)
            units = set()
            for sub in kids(sym, 'symbol'):
                sn = sub[1][1] if isinstance(sub[1], tuple) else ''
                parts = sn.rsplit('_', 2)
                if len(parts) == 3 and parts[1].isdigit():
                    units.add(int(parts[1]))
            local[name] = {
                'ref': get_prop(sym, 'Reference') or 'U',
                'pins': pins,
                'units': max(len([u for u in units if u > 0]), 1),
                'desc': get_prop(sym, 'Description') or '',
                'kw': get_prop(sym, 'ki_keywords') or '',
                'extends': ext,
            }
        # resolve extends pin counts
        for name, e in local.items():
            seen = set()
            base = e['extends']
            while base and base in local and base not in seen:
                seen.add(base)
                if e['pins'] == 0:
                    e['pins'] = local[base]['pins']
                if not e['desc']:
                    e['desc'] = local[base]['desc']
                if not e['kw']:
                    e['kw'] = local[base]['kw']
                base = local[base]['extends']
        for name, e in local.items():
            entries.append({
                'id': lib + ':' + name,
                'ref': e['ref'],
                'pins': e['pins'],
                'units': e['units'],
                'desc': e['desc'],
                'kw': e['kw'],
            })
    entries.sort(key=lambda x: x['id'].lower())
    print(f"libs={len(files)} symbols={len(entries)} in {time.time()-t0:.1f}s")
    # show a few well-known ones
    for want in ('Device:R', 'Device:C', 'Device:D', 'Device:L', 'Transistor_FET:AO3400A'):
        m = next((e for e in entries if e['id'] == want), None)
        print('  ', want, '->', m)

    out = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
    payload = json.dumps(entries, separators=(',', ':'), ensure_ascii=False)
    jpath = os.path.join(out, 'symbols_kicad.json')
    with open(jpath, 'w', encoding='utf-8') as fh:
        fh.write(payload)
    # file:// fallback: a <script> that assigns the catalog (fetch() is CORS-blocked on file://)
    spath = os.path.join(out, 'symbols_kicad.js')
    with open(spath, 'w', encoding='utf-8') as fh:
        fh.write('window.KICAD_SYMBOLS = ' + payload + ';\n')
    print(f"wrote {jpath} ({os.path.getsize(jpath)//1024} KB)")
    print(f"wrote {spath} ({os.path.getsize(spath)//1024} KB)")
    return entries

if __name__ == '__main__':
    main()
