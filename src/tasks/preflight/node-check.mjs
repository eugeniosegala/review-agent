import fs from 'node:fs';
import path from 'node:path';
import { builtinModules, createRequire } from 'node:module';

// The runner copies this verifier into the frozen probe and supplies its own semver library.
const semver = createRequire(import.meta.url)(process.argv[3]);
const repo = process.env.REVIEW_REPO;
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const emit = (status, expected, actual, details) => {
  console.log('REVIEW_AGENT_OBSERVATION:' + JSON.stringify({ status, expected, actual, details }));
  process.exitCode = status === 'pass' ? 0 : status === 'violation' ? 1 : 2;
};

function installed(name, from) {
  const req = createRequire(from);
  // Package metadata can be hidden by exports. Use the actual Node search hierarchy.
  for (const directory of req.resolve.paths(name) || []) {
    const file = path.join(directory, name, 'package.json');
    if (fs.existsSync(file)) return { file: fs.realpathSync(file), manifest: read(file) };
  }
  throw new Error('MODULE_NOT_FOUND: ' + name);
}

try {
  const manifestFile = path.join(repo, 'package.json');
  const manifest = read(manifestFile);
  const engine = manifest.engines?.node;
  if (process.argv[2] === 'runtime') {
    if (engine && !semver.validRange(engine)) emit('error', 'A verifiable Node engine range', process.version, 'Unsupported Node engine declaration: ' + engine);
    else {
      const compatible = !engine || semver.satisfies(process.version, engine);
      emit(compatible ? 'pass' : 'violation', engine ? 'Node ' + engine : 'Available Node; package compatibility checked separately', process.version,
        compatible ? 'Runtime is available and satisfies declared compatibility. Toolchain pins are preferences, not evidence of incompatibility.' : 'The selected runtime violates package.json engines.node.');
    }
  } else {
    let lock = null;
    if (fs.existsSync(path.join(repo, 'package-lock.json'))) lock = read(path.join(repo, 'package-lock.json'));
    const direct = { ...manifest.dependencies };
    const test = manifest.scripts?.test || '';
    for (const [name, range] of Object.entries(manifest.devDependencies || {})) {
      if (test.includes(name) || test.includes(name.split('/').pop())) direct[name] = range;
    }
    const problems = [];
    const checked = new Set();
    const root = [];
    const visit = (name, range, from, lockedVersion, optional = false) => {
      if (builtinModules.includes(name.replace(/^node:/, ''))) return;
      let found;
      try { found = installed(name, from); }
      catch (error) { if (!optional) problems.push(name + ': ' + error.message); return; }
      const pkg = found.manifest;
      if (lockedVersion && pkg.version !== lockedVersion) problems.push(name + ': installed ' + pkg.version + ', locked ' + lockedVersion);
      else if (semver.validRange(range) && !semver.satisfies(pkg.version, range)) problems.push(name + ': installed ' + pkg.version + ', required ' + range);
      if (checked.has(found.file)) return;
      checked.add(found.file);
      if (checked.size > 2000) throw new Error('Dependency traversal exceeded its verification limit');
      if (pkg.engines?.node && semver.validRange(pkg.engines.node) && !semver.satisfies(process.version, pkg.engines.node)) problems.push(name + ': Node ' + process.version + ' violates engines ' + pkg.engines.node);
      for (const [dependency, required] of Object.entries(pkg.dependencies || {})) visit(dependency, required, found.file, null, dependency in (pkg.optionalDependencies || {}));
      for (const [peer, required] of Object.entries(pkg.peerDependencies || {})) visit(peer, required, found.file, null, pkg.peerDependenciesMeta?.[peer]?.optional === true);
    };
    for (const [name, range] of Object.entries(direct)) {
      const locked = lock?.packages?.['node_modules/' + name]?.version ?? lock?.dependencies?.[name]?.version;
      const lockDeclaration = lock?.packages?.['']?.dependencies?.[name] ?? lock?.packages?.['']?.devDependencies?.[name];
      if (lockDeclaration && lockDeclaration !== range) problems.push(name + ': manifest and lockfile declarations differ');
      visit(name, range, manifestFile, locked, name in (manifest.optionalDependencies || {}));
      root.push(name);
    }
    emit(problems.length ? 'violation' : 'pass', 'Resolvable runtime and test-tool dependencies compatible with this snapshot', problems.length ? problems.slice(0, 20).join('; ') : root.length + ' direct packages; ' + checked.size + ' installed packages verified',
      problems.length ? 'Dependency verification found: ' + problems.slice(0, 20).join('; ') : 'Resolved dependencies through the snapshot ancestor hierarchy without importing application code or assuming snapshot-local node_modules.');
  }
} catch (error) {
  emit('error', 'Verifiable application toolchain and dependencies', 'Verification failed', error.message);
}
