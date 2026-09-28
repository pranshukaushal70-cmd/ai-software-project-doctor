export interface TreeNode {
  name: string;
  path: string;
  type: "dir" | "file";
  size: number;
  fileCount: number;
  children?: TreeNode[];
}

/** Build a nested directory tree from flat posix paths. Directories sort before files. */
export function buildTree(files: Array<{ path: string; size: number }>, rootName = ""): TreeNode {
  const root: TreeNode = { name: rootName, path: "", type: "dir", size: 0, fileCount: 0, children: [] };
  const dirs = new Map<string, TreeNode>([["", root]]);

  for (const file of files) {
    const parts = file.path.split("/");
    let parent = root;
    let current = "";
    for (let i = 0; i < parts.length - 1; i++) {
      current = current ? `${current}/${parts[i]}` : parts[i]!;
      let dir = dirs.get(current);
      if (!dir) {
        dir = { name: parts[i]!, path: current, type: "dir", size: 0, fileCount: 0, children: [] };
        dirs.set(current, dir);
        parent.children!.push(dir);
      }
      parent = dir;
    }
    parent.children!.push({ name: parts.at(-1)!, path: file.path, type: "file", size: file.size, fileCount: 1 });
  }

  const finalize = (node: TreeNode): void => {
    if (node.type === "file") return;
    node.children!.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    node.size = 0;
    node.fileCount = 0;
    for (const child of node.children!) {
      finalize(child);
      node.size += child.size;
      node.fileCount += child.fileCount;
    }
  };
  finalize(root);
  return root;
}
