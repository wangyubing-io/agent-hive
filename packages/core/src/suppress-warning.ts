// 屏蔽 node:sqlite 的 ExperimentalWarning（Node 22 内置模块的实验性提示；功能已验证稳定）。
// 兜底防线：主防线是启动脚本的 --disable-warning=ExperimentalWarning（node --import tsx/esm 同进程模式）；
// 本模块作为次级兜底——在模块评估顺序正确的上下文里拦截首次警告。
// 注意：tsx CLI（子进程模式）下 node:sqlite 可能先于本模块加载（loader 时序怪癖），此时由主防线生效。
const origEmit = process.emit.bind(process) as (...args: unknown[]) => boolean;
process.emit = ((name: string | symbol, data: unknown, ...rest: unknown[]) => {
  if (name === "warning" && (data as Error | undefined)?.name === "ExperimentalWarning") return false;
  return origEmit(name, data, ...rest);
}) as typeof process.emit;
