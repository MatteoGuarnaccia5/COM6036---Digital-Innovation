/**
 * Layer enforcement, mechanism 3 of 3.
 *
 * This suite is a deliverable in its own right: it is the evidence that the
 * layering described in the report is enforced by the build rather than merely
 * agreed by convention. It parses every source file in each layer with the
 * TypeScript compiler API - not a regular expression - and fails if a file
 * imports something the layer is not allowed to see.
 *
 * The boundaries themselves live in tools/layer-rules.json, which ESLint reads
 * too, so the rule is written down once and checked in two places.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

interface LayerRule {
  readonly layer: string;
  readonly path: string;
  readonly forbidden: readonly string[];
  readonly message: string;
}

const layerRules: readonly LayerRule[] = JSON.parse(
  await readFile(path.join(REPO_ROOT, 'tools/layer-rules.json'), 'utf8'),
).rules;

const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'dist-client', 'coverage']);

async function listSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return IGNORED_DIRECTORIES.has(entry.name) ? [] : listSourceFiles(absolute);
      }
      return /\.tsx?$/.test(entry.name) ? [absolute] : [];
    }),
  );
  return files.flat();
}

/**
 * Every module specifier the file imports, however it is written: static
 * import, re-export, bare side-effect import, dynamic `import()`, or
 * `require()`. Using the compiler's own parser means comments and string
 * literals cannot produce a false positive or a false negative.
 */
function collectImportSpecifiers(sourceText: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ESNext, true);
  const specifiers: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }

    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const reference = node.moduleReference.expression;
      if (ts.isStringLiteral(reference)) specifiers.push(reference.text);
    }

    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const [firstArgument] = node.arguments;
      if ((isDynamicImport || isRequire) && firstArgument && ts.isStringLiteral(firstArgument)) {
        specifiers.push(firstArgument.text);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
}

const isForbidden = (specifier: string, forbidden: readonly string[]): boolean =>
  forbidden.some((name) => specifier === name || specifier.startsWith(`${name}/`));

describe('architecture: layer boundaries', () => {
  it('defines at least one boundary rule', () => {
    expect(layerRules.length).toBeGreaterThan(0);
  });

  for (const rule of layerRules) {
    describe(`${rule.layer} (${rule.path})`, () => {
      it('imports nothing from a forbidden layer', async () => {
        const files = await listSourceFiles(path.join(REPO_ROOT, rule.path));
        expect(files.length).toBeGreaterThan(0);

        const violations: string[] = [];
        for (const file of files) {
          const specifiers = collectImportSpecifiers(await readFile(file, 'utf8'), file);
          for (const specifier of specifiers) {
            if (isForbidden(specifier, rule.forbidden)) {
              violations.push(`${path.relative(REPO_ROOT, file)} imports "${specifier}"`);
            }
          }
        }

        expect(violations, `${rule.message}\n\n${violations.join('\n')}`).toEqual([]);
      });
    });
  }
});

describe('architecture: business logic is self-contained', () => {
  it('declares no runtime dependencies in its package.json', async () => {
    const manifest: { dependencies?: Record<string, string> } = JSON.parse(
      await readFile(path.join(REPO_ROOT, 'packages/core/package.json'), 'utf8'),
    );
    expect(Object.keys(manifest.dependencies ?? {})).toEqual([]);
  });

  it('contains no relative import that escapes the package', async () => {
    const coreRoot = path.join(REPO_ROOT, 'packages/core');
    const files = await listSourceFiles(coreRoot);

    const escapes: string[] = [];
    for (const file of files) {
      const specifiers = collectImportSpecifiers(await readFile(file, 'utf8'), file);
      for (const specifier of specifiers.filter((value) => value.startsWith('.'))) {
        const resolved = path.resolve(path.dirname(file), specifier);
        if (!resolved.startsWith(coreRoot)) {
          escapes.push(`${path.relative(REPO_ROOT, file)} imports "${specifier}"`);
        }
      }
    }

    expect(escapes).toEqual([]);
  });
});
