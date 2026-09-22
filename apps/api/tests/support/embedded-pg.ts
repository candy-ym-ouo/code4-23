import { copyFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";

/**
 * 端到端测试使用 zonky embedded-postgres（真实的 PostgreSQL 16 二进制）。
 * 该二进制构建于 Debian buster 时代，运行环境（Debian bookworm）缺少其依赖的
 * ICU 60 系列共享库（libicuuc.so.60 / libicui18n.so.60 / libicudata.so.60）。
 *
 * 这里不修改系统环境，仅在非 root 前提下完成：
 *   1. 检查 postgres 可执行文件是否还能解析全部动态库；
 *   2. 若缺少 ICU 60，则从 Ubuntu 官方端口下载对应架构的 libicu60 .deb，
 *      解压到仓库内可复现的缓存目录（.embedded-pg-libs）；
 *   3. 通过 LD_LIBRARY_PATH 指向该目录（必须在子进程启动前设置）。
 *
 * 选择 LD_LIBRARY_PATH 而非把文件复制进 node_modules：DT_RUNPATH 不会被
 * 传递性依赖（icuuc -> icudata）继承，因此必须借助动态链接器的搜索路径。
 */

const ICU_LIB_SONAMES = ["libicudata.so.60", "libicui18n.so.60", "libicuuc.so.60"];
const ICU_DEB_URLS: Record<string, string> = {
  arm64: "http://ports.ubuntu.com/pool/main/i/icu/libicu60_60.2-3ubuntu3.2_arm64.deb",
  x64: "http://archive.ubuntu.com/ubuntu/pool/main/i/icu/libicu60_60.2-3ubuntu3.2_amd64.deb"
};

function resolveEmbeddedPostgresPackage(): string {
  const require = createRequire(import.meta.url);
  // 该包的 exports 未暴露 ./package.json，只能解析其主入口再上溯两级得到包根。
  const entry = require.resolve("embedded-postgres");
  return path.dirname(path.dirname(entry));
}

function nativePackageDir(packageDir: string): string {
  // 平台二进制是 embedded-postgres 的可选依赖；pnpm 将其放在该包旁的
  // node_modules/@embedded-postgres/<platform> 下。
  const requireFromPackage = createRequire(path.join(packageDir, "dist", "index.js"));
  const platformPackage = `@embedded-postgres/${process.platform}-${process.arch}`;
  try {
    const entry = requireFromPackage.resolve(platformPackage);
    // 平台包入口为 <root>/dist/index.js，native 目录与 dist 同级。
    return path.dirname(path.dirname(entry));
  } catch {
    throw new Error(
      `未找到平台对应的 embedded-postgres 二进制包 ${platformPackage}，端到端测试需要本机 PostgreSQL 二进制`
    );
  }
}
function listMissingLibraries(executable: string): string[] {
  const result = spawnSync("ldd", [executable], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`无法通过 ldd 检查 ${executable} 的动态库依赖：${result.stderr}`);
  }
  return result.stdout
    .split("\n")
    .map((line) => /^\s*(\S+)\s+=>\s+not found/.exec(line)?.[1])
    .filter((name): name is string => Boolean(name));
}

function downloadAndExtractIcu60(targetDir: string): void {
  const url = ICU_DEB_URLS[process.arch];
  if (!url) {
    throw new Error(`架构 ${process.arch} 没有预构建的 libicu60 缓存方案，请在本机安装 ICU 60 后重试`);
  }
  mkdirSync(targetDir, { recursive: true });
  const debFile = path.join(os.tmpdir(), `libicu60-${process.arch}-${process.pid}.deb`);
  const download = spawnSync("curl", ["-fsSL", "-o", debFile, url], { stdio: "inherit" });
  if (download.status !== 0) {
    throw new Error(`下载 libicu60 失败（${url}）`);
  }
  const extractRoot = path.join(targetDir, "extract");
  mkdirSync(extractRoot, { recursive: true });
  const extract = spawnSync("dpkg-deb", ["-x", debFile, extractRoot], { stdio: "inherit" });
  if (extract.status !== 0) {
    throw new Error("解压 libicu60 .deb 失败，需要 dpkg-deb 工具");
  }
  // dpkg 内的 .so.60 一般是指向 .so.60.2 的符号链接；virtiofs 等挂载可能
  // 错误处理符号链接，这里统一复制为实体文件。
  const arTriplet = process.arch === "arm64" ? "aarch64-linux-gnu" : "x86_64-linux-gnu";
  const debLibDir = path.join(extractRoot, "usr", "lib", arTriplet);
  for (const soname of ICU_LIB_SONAMES) {
    const versioned = path.join(debLibDir, `${soname}.2`);
    if (!existsSync(versioned)) {
      throw new Error(`解压结果中缺少 ${versioned}`);
    }
    copyFileSync(versioned, path.join(targetDir, soname));
  }
  rmSync(extractRoot, { recursive: true, force: true });
}

export function ensureEmbeddedPostgresLibraries(): { nativeDir: string; libDir: string } {
  const packageDir = resolveEmbeddedPostgresPackage();
  const nativeDir = nativePackageDir(packageDir);
  const postgresBin = path.join(nativeDir, "native", "bin", "postgres");
  const initdbBin = path.join(nativeDir, "native", "bin", "initdb");
  if (!existsSync(postgresBin)) {
    throw new Error(`embedded-postgres 二进制不存在：${postgresBin}`);
  }

  // 若系统已自带所需库（例如运行在 Debian buster/Ubuntu 18.04 上），直接使用。
  if (listMissingLibraries(initdbBin).length === 0 && listMissingLibraries(postgresBin).length === 0) {
    return { nativeDir, libDir: "" };
  }

  const libDir = path.join(nativeDir, ".embedded-pg-libs");
  const provisioned = ICU_LIB_SONAMES.every((soname) => existsSync(path.join(libDir, soname)));
  if (!provisioned) {
    downloadAndExtractIcu60(libDir);
  }

  // 用 LD_LIBRARY_PATH 再验证一次；注意 DT_RUNPATH 不向传递性依赖传递。
  const env = { ...process.env, LD_LIBRARY_PATH: [libDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter) };
  const stillMissing = new Set([
    ...listMissingLibrariesWithEnv(initdbBin, env),
    ...listMissingLibrariesWithEnv(postgresBin, env)
  ]);
  if (stillMissing.size > 0) {
    throw new Error(`embedded-postgres 仍缺少动态库：${[...stillMissing].join(", ")}`);
  }
  process.env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH;
  return { nativeDir, libDir };
}

function listMissingLibrariesWithEnv(executable: string, env: NodeJS.ProcessEnv): string[] {
  const result = spawnSync("ldd", [executable], { encoding: "utf8", env });
  if (result.status !== 0) {
    throw new Error(`无法通过 ldd 检查 ${executable} 的动态库依赖：${result.stderr}`);
  }
  return result.stdout
    .split("\n")
    .map((line) => /^\s*(\S+)\s+=>\s+not found/.exec(line)?.[1])
    .filter((name): name is string => Boolean(name));
}

/** 读取 native 包的 pg-symlinks.json，确认二进制版本（仅用于错误信息）。 */
export function describeEmbeddedPackage(nativeDir: string): string {
  const metadataFile = path.join(nativeDir, "package.json");
  if (existsSync(metadataFile)) {
    const metadata = JSON.parse(readFileSync(metadataFile, "utf8")) as { version?: string };
    return metadata.version ?? "unknown";
  }
  return "unknown";
}
