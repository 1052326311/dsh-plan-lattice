import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sha256 } from '../../lib/canonical.mjs'

const IGNORED_ROOTS = new Set(['.dsh', '.git', 'node_modules', '__pycache__'])

function execute(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

async function inventory(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (directory === root && IGNORED_ROOTS.has(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await inventory(root, path))
    else files.push(relative(root, path))
  }
  return files.sort()
}

async function noDependencies(workspace) {
  try {
    const manifest = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8'))
    return ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
      .every((key) => Object.keys(manifest[key] ?? {}).length === 0)
  } catch {
    return false
  }
}

async function onlyTargetChanged(workspace, task, target) {
  const expected = Object.keys(task.initialFiles).sort()
  const actual = await inventory(workspace)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) return false
  for (const [path, content] of Object.entries(task.initialFiles)) {
    if (path === target) continue
    if (await readFile(join(workspace, path), 'utf8') !== content) return false
  }
  return true
}

function parseBooleanArray(result, count) {
  if (!result.ok) return Array(count).fill(false)
  try {
    const values = JSON.parse(result.stdout.trim())
    if (!Array.isArray(values) || values.length !== count) return Array(count).fill(false)
    return values.map(Boolean)
  } catch {
    return Array(count).fill(false)
  }
}

function javascriptAssertions(workspace, file, expression) {
  const url = `${pathToFileURL(join(workspace, file)).href}?grader=${Date.now()}`
  const source = `
    const mod = await import(${JSON.stringify(url)});
    const fn = mod[${JSON.stringify(expression)}];
    const results = [];
    const check = (body) => { try { results.push(Boolean(body())) } catch { results.push(false) } };
    ${expression === 'clamp' ? `
      check(() => typeof fn === 'function');
      check(() => fn(-2, 0, 10) === 0 && fn(20, 0, 10) === 10);
      check(() => fn(4, 0, 10) === 4);
      check(() => { try { fn(0, 2, 1); return false } catch (error) { return error instanceof RangeError } });
    ` : `
      check(() => fn('1') === 1 && fn('65535') === 65535);
      check(() => fn(' 8080 ') === 8080);
      check(() => ['1.5', '+1', '-1', '1e2', '', '0', '65536'].every((value) => { try { fn(value); return false } catch (error) { return error instanceof RangeError } }));
      check(() => { try { fn(80); return false } catch (error) { return error instanceof TypeError } });
    `}
    process.stdout.write(JSON.stringify(results));
  `
  return parseBooleanArray(execute(process.execPath, ['--input-type=module', '-e', source], workspace), 4)
}

function typescriptAssertions(workspace) {
  const url = `${pathToFileURL(join(workspace, 'src/slugify.ts')).href}?grader=${Date.now()}`
  const source = `
    const { slugify } = await import(${JSON.stringify(url)});
    const results = [];
    const check = (body) => { try { results.push(Boolean(body())) } catch { results.push(false) } };
    check(() => slugify('Hello WORLD') === 'hello-world');
    check(() => slugify('a___b...c') === 'a-b-c');
    check(() => slugify(' --A B-- ') === 'a-b');
    check(() => slugify('   ') === '');
    process.stdout.write(JSON.stringify(results));
  `
  return parseBooleanArray(execute(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], workspace), 4)
}

function pythonAssertions(workspace, taskId) {
  const chunks = taskId === 'simple-python-chunks'
  const file = chunks ? 'chunks.py' : 'text_utils.py'
  const symbol = chunks ? 'chunks' : 'normalize_whitespace'
  const source = `
import importlib.util, json
spec = importlib.util.spec_from_file_location('submission', ${JSON.stringify(join(workspace, file))})
module = importlib.util.module_from_spec(spec)
results = []
try:
    spec.loader.exec_module(module)
    fn = getattr(module, ${JSON.stringify(symbol)})
except Exception:
    fn = None
def check(body):
    try: results.append(bool(body()))
    except Exception: results.append(False)
${chunks ? `
check(lambda: fn([1, 2, 3, 4], 2) == [[1, 2], [3, 4]])
check(lambda: fn([1, 2, 3], 2) == [[1, 2], [3]])
check(lambda: fn([], 3) == [])
def invalid_sizes():
    for value in (True, False, 0, -1, 1.5, '2'):
        try: fn([1], value)
        except ValueError: continue
        return False
    return True
check(invalid_sizes)
def immutable():
    value = [1, 2, 3]
    fn(value, 2)
    return value == [1, 2, 3]
check(immutable)
` : `
check(lambda: fn('  a   b ') == 'a b')
check(lambda: fn('a\\t\\n b') == 'a b')
check(lambda: fn('a\\u2003\\u00a0b') == 'a b')
check(lambda: fn('') == '')
`}
print(json.dumps(results))
  `
  return parseBooleanArray(execute('python3', ['-I', '-c', source], workspace), chunks ? 5 : 4)
}

function pythonStandardLibraryOnly(workspace, file) {
  const source = `
import ast, json, pathlib, sys
tree = ast.parse(pathlib.Path(${JSON.stringify(join(workspace, file))}).read_text())
roots = []
for node in ast.walk(tree):
    if isinstance(node, ast.Import): roots.extend(alias.name.split('.')[0] for alias in node.names)
    elif isinstance(node, ast.ImportFrom) and node.module: roots.append(node.module.split('.')[0])
print(json.dumps(all(name in sys.stdlib_module_names for name in roots)))
  `
  const result = execute('python3', ['-I', '-c', source], workspace)
  return result.ok && result.stdout.trim() === 'true'
}

async function goAssertions(workspace) {
  const tests = {
    TestStable: `func TestStable(t *testing.T) { got := DedupeStable([]string{"b", "a", "b", "c", "a"}); if !reflect.DeepEqual(got, []string{"b", "a", "c"}) { t.Fatal(got) } }`,
    TestImmutable: `func TestImmutable(t *testing.T) { in := []string{"a", "a"}; got := DedupeStable(in); got[0] = "x"; if in[0] != "a" { t.Fatal(in) } }`,
    TestNil: `func TestNil(t *testing.T) { if DedupeStable(nil) != nil { t.Fatal("nil") } }`,
    TestEmpty: `func TestEmpty(t *testing.T) { got := DedupeStable([]string{}); if got == nil || len(got) != 0 { t.Fatal(got) } }`,
  }
  const results = []
  for (const [name, body] of Object.entries(tests)) {
    await writeFile(join(workspace, 'grader_hidden_test.go'), `package dedupe\n\nimport (\n  "reflect"\n  "testing"\n)\n\n${body}\n`, 'utf8')
    results.push(execute('go', ['test', '-run', `^${name}$`, './...'], workspace).ok)
  }
  await rm(join(workspace, 'grader_hidden_test.go'), { force: true })
  const module = await readFile(join(workspace, 'go.mod'), 'utf8').catch(() => '')
  const noExternalDependencies = !/^\s*require\s/m.test(module)
    && !(await inventory(workspace)).some((path) => basename(path) === 'go.sum')
  return [...results, noExternalDependencies]
}

export async function gradeSimpleTask(task, sourceWorkspace) {
  const graderRoot = await mkdtemp(join(tmpdir(), 'plan-lattice-simple-grader-'))
  const workspace = join(graderRoot, 'submission')
  await cp(sourceWorkspace, workspace, { recursive: true })
  let checks
  try {
    switch (task.id) {
      case 'simple-js-clamp':
        checks = [
          ...javascriptAssertions(workspace, 'src/clamp.js', 'clamp'),
          await noDependencies(workspace),
        ]
        break
      case 'simple-ts-slugify':
        checks = [
          ...typescriptAssertions(workspace),
          await onlyTargetChanged(workspace, task, 'src/slugify.ts'),
        ]
        break
      case 'simple-python-whitespace':
        checks = [
          ...pythonAssertions(workspace, task.id),
          pythonStandardLibraryOnly(workspace, 'text_utils.py'),
        ]
        break
      case 'simple-go-dedupe':
        checks = await goAssertions(workspace)
        break
      case 'simple-js-parse-port':
        checks = [
          ...javascriptAssertions(workspace, 'src/port.js', 'parsePort'),
          await noDependencies(workspace),
        ]
        break
      case 'simple-python-chunks':
        checks = pythonAssertions(workspace, task.id)
        break
      default:
        throw new Error(`unknown simple task ${task.id}`)
    }
    if (checks.length !== task.graderAssertions.length) {
      throw new Error(`grader assertion count mismatch for ${task.id}: ${checks.length} != ${task.graderAssertions.length}`)
    }
    return {
      score: checks.filter(Boolean).length,
      maxScore: checks.length,
      checks: task.graderAssertions.map((name, index) => ({ name, passed: checks[index] })),
      graderDigest: sha256(await readFile(new URL(import.meta.url))),
    }
  } finally {
    await rm(graderRoot, { recursive: true, force: true })
  }
}

export async function materializeSimpleTask(task, workspace) {
  for (const [path, content] of Object.entries(task.initialFiles)) {
    const absolute = resolve(workspace, path)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, content, 'utf8')
  }
}
