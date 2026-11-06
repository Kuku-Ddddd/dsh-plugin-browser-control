/**
 * defineTool 的本地实现（vendor 自 @deepseek-ai/dsh-tools 的语义子集）。
 *
 * 为什么不用宿主那个：插件以 `link:` 挂在 profile 的 node_modules 之外，
 * ESM 裸导入 `@deepseek-ai/dsh-tools` 会逐级向上找 node_modules 而找不到
 * （实测 ERR_MODULE_NOT_FOUND）；dsh-tools 又在其 protectedModules 名单里，
 * 第三方 profile 装不进去。所以这里只保留本插件真正用到的语义：
 * parameters 规格 → JSON Schema、执行前校验、透传 execute。
 */

const TYPE_OF = (v) => (typeof v === 'number' && Number.isFinite(v) ? 'number'
  : typeof v === 'string' ? 'string'
    : typeof v === 'boolean' ? 'boolean' : undefined)

function specToJsonSchema(spec = {}) {
  const properties = {}
  const required = []
  for (const [key, p] of Object.entries(spec)) {
    properties[key] = {
      ...(p.type === undefined ? {} : { type: p.type }),
      ...(p.enum === undefined ? {} : { enum: p.enum }),
      ...(p.description === undefined ? {} : { description: p.description }),
    }
    if (p.required) required.push(key)
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}), additionalProperties: false }
}

function violationsOf(schema, args = {}) {
  const bad = []
  for (const key of schema.required ?? []) if (args[key] === undefined) bad.push(`缺少必填参数 ${key}`)
  for (const [key, value] of Object.entries(args)) {
    const p = schema.properties?.[key]
    if (p === undefined) { bad.push(`未知参数 ${key}`); continue }
    if (p.type !== undefined && TYPE_OF(value) !== p.type) bad.push(`参数 ${key} 需要 ${p.type}`)
    if (p.enum !== undefined && !p.enum.includes(value)) bad.push(`参数 ${key} 必须是 ${p.enum.join('|')} 之一`)
  }
  return bad
}

export function defineTool(options) {
  if (options.output?.render === undefined) throw new Error(`defineTool(${options.name}): 需要 output.render`)
  const parameters = specToJsonSchema(options.parameters)
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: { schema: options.output.schema ?? { type: 'object' }, render: options.output.render },
    async execute(args, exec) {
      const bad = violationsOf(parameters, args)
      if (bad.length > 0) throw new Error(`无效参数：${bad.join('；')}`)
      return options.execute(args, exec)
    },
  }
}
