import { extname } from 'node:path';
import { normalizeRepositoryPath } from '@lat.md/core/repository-path';
import { isSourceFileExtension } from '@lat.md/core/source-formats';
import { rewriteDocumentLink } from './document-route.js';

/**
 * Resolve ordinary code links relative to their Markdown file, not the vault
 * root. `vaultPrefix` is the vault path plus a trailing slash (`lat.md/` or
 * `docs/`); it sets the synthetic URL's depth to match the real project-relative
 * path, so an escaping relative path cannot be normalized back into the project.
 */
export function rewriteLocalFileLink(
  value: string,
  sourcePath: string,
  vaultPrefix = 'lat.md/',
): string {
  if (value && !/^(?:[#/]|[a-z][a-z\d+.-]*:)/i.test(value)) {
    try {
      const base = sourcePath.split('/').map(encodeURIComponent).join('/');
      const url = new URL(
        value,
        `http://lat.local/project/${vaultPrefix}${base}`,
      );
      if (
        url.origin === 'http://lat.local' &&
        url.pathname.startsWith('/project/')
      ) {
        const path = decodeURIComponent(url.pathname.slice('/project/'.length));
        if (
          normalizeRepositoryPath(path) &&
          (!path.startsWith(vaultPrefix) ||
            isSourceFileExtension(extname(path)))
        ) {
          return `/code/${path.split('/').map(encodeURIComponent).join('/')}${url.search}${url.hash}`;
        }
      }
    } catch {
      // Malformed URLs retain the ordinary document/resource fallback.
    }
  }
  return rewriteDocumentLink(value, sourcePath);
}

export type ViewSourceTarget = {
  path: string;
  symbol: string;
  key: string;
  fileKey: string;
};

/** Normalize a supported source wiki-link target for view indexes and routes. */
export function viewSourceTarget(target: string): ViewSourceTarget | null {
  const hash = target.indexOf('#');
  const authoredPath = hash === -1 ? target : target.slice(0, hash);
  const path = normalizeRepositoryPath(authoredPath);
  if (!path || !isSourceFileExtension(extname(path))) return null;

  const symbol = hash === -1 ? '' : target.slice(hash + 1);
  const fileKey = path.toLowerCase();
  return {
    path,
    symbol,
    key: `${fileKey}${symbol ? `#${symbol.toLowerCase()}` : ''}`,
    fileKey,
  };
}
