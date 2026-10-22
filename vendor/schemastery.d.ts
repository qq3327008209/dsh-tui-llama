/**
 * 类型侧桥接：`#schemastery` 的运行时实体是本包 vendor 的副本，
 * 但类型直接沿用 devDependency 里真正的 @deepseek-ai/schemastery，
 * 避免在 vendor 副本上重复维护一套类型。
 *
 * tsconfig 的 moduleResolution 会顺着 package.json 的 "imports" 字段
 * 把 `#schemastery` 解析到 ./vendor/schemastery.js，再找同名的 .d.ts。
 */
export * from '@deepseek-ai/schemastery';
export { default } from '@deepseek-ai/schemastery';
