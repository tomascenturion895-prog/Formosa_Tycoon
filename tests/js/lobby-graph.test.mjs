// El lobby tiene que ser liviano: su código no puede arrastrar el mapa (MapLibre), la vista 3D (three.js) ni la cinemática de carga.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRY = resolve(root, 'resources/js/lobby/main.js');
const FORBIDDEN_BARE = [/^maplibre-gl(\/|$)/, /^three(\/|$)/];
const FORBIDDEN_FILE = [/resources\/js\/map\/main\.js$/, /resources\/js\/map\/intro\.js$/, /resources\/js\/map\/city[^/]*\.js$/];

function specifiersOf(source) {
    const out = [];
    const re = /(?:^|[\s;])(?:import|export)\s+(?:[^'"()]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
    for (const m of source.matchAll(re)) {
        out.push(m[1] ?? m[2]);
    }
    return out;
}

function walk(file, seen = new Set(), problems = []) {
    if (seen.has(file)) return { seen, problems };
    seen.add(file);
    for (const raw of specifiersOf(readFileSync(file, 'utf8'))) {
        const spec = raw.split('?')[0];
        if (!spec.startsWith('.')) {
            if (FORBIDDEN_BARE.some((re) => re.test(spec))) problems.push(`${relative(root, file)} importa ${spec}`);
            continue;
        }
        const target = resolve(dirname(file), spec);
        if (FORBIDDEN_FILE.some((re) => re.test(target.replaceAll('\\', '/')))) problems.push(`${relative(root, file)} importa ${relative(root, target)}`);
        else if (existsSync(target)) walk(target, seen, problems);
    }
    return { seen, problems };
}

test('el lobby no arrastra MapLibre, three.js, la cinemática ni la ciudad 3D', () => {
    assert.ok(existsSync(ENTRY), 'falta resources/js/lobby/main.js');
    const { seen, problems } = walk(ENTRY);
    assert.deepEqual(problems, []);
    assert.ok(seen.size >= 3, 'el recorrido debería alcanzar varios módulos del lobby');
});

test('el recorrido detecta una importación prohibida (control del propio test)', () => {
    assert.deepEqual(specifiersOf("import * as m from 'maplibre-gl';\nimport x from './a.js';\nawait import('three');").sort(), ['./a.js', 'maplibre-gl', 'three']);
});
