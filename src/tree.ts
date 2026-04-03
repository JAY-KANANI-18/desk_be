import * as fs from "fs";
import * as path from "path";
function printTree(dir: string, prefix = ""): void {
  const files = fs.readdirSync(dir);
  const lastIndex = files.length - 1;

  files.forEach((file, index) => {
    const filePath = path.join(dir, file);
    const isLast = index === lastIndex;

    const connector = isLast ? "└── " : "├── ";
    console.log(prefix + connector + file);

    if (fs.statSync(filePath).isDirectory()) {
      const newPrefix = prefix + (isLast ? "    " : "│   ");
      printTree(filePath, newPrefix);
    }
  });
}

const srcDir = path.join(process.cwd(), "src");

if (!fs.existsSync(srcDir)) {
  console.error("src folder not found");
  process.exit(1);
}

console.log("src");
printTree(srcDir);