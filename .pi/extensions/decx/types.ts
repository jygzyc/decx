/**
 * A small filesystem abstraction keeps every knowledge-layer operation portable
 * between the pi extension, the standalone CLI and in-memory tests.
 */

export interface WikiFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  createFile(path: string, text: string): Promise<boolean>;
  exists(path: string): Promise<boolean>;
  listDir(path: string): Promise<string[]>;
  mkdirp(path: string): Promise<void>;
}
