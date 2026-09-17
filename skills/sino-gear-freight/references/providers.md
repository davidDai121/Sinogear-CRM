# 入口核验与边界

2026-09-17核验。用户要求多家公开网页搜索，不以固定货代/API账号为前置，不做填写页面。

- 物流巴巴/Awice公开整柜页：https://www.5688.cn/en/fcl 。搜索引擎可查航线页，核对有效期和附加费；其付费API另需密钥，普通网页检索不必开通API。
- Flexport公开航线搜索：https://www.flexport.com/data/route-search/ 。已找到上海→La Guaira公开页，但当次页面有效期已到2026-09-01，不能作为9月17日当前价。公开普通货运费不等于车辆/电池承运确认。
- 搜运费：https://souyunfei.com/fcl/origin/CNSHA 。有船司、航程与开船日期；日期过期或未显示数字不能升级为现价。
- 其他公开货代/船司页面用航线及当前月份搜索；3–5家独立来源，同口径采用最高可比价作估算。查不到须保存尝试，不要求用户提供固定货代。

- SHAQ发布者文档：https://search.shaq-logistics.com/mcp-guide
- 接口：https://search.shaq-logistics.com/mcp
- 实测initialize、tools/list、search_freight_rates成功。实际schema为origin、destination、container_type；不是早期教程的origin_port。只读工具由运行时tools/list确认。
- 上海→La Guaira、40HQ返回No rates found。随后另一次初始化出现HTTP522，说明可用性有波动。不能据“接通”声称常用航线已有有效整车价。
- API不接收车辆动力/台数，因此它没有核验整车承运。客户端保留车辆信息供后续确认，所有运价初始标为reference/unconfirmed。
- 40HC为40HQ常见命名；确认返回柜型，不以改名掩盖无结果。
- SeaRates备用官方入口：https://docs.searates.com/reference/logistics/get-rates 。需要账号/API权限时说明缺的是什么，不猜凭据或付费。
- ShippingRates备用：https://shippingrates.org/docs 。其公开额度后的HTTP402是付费边界；不自动支付。未验证的航线和报价不写为可用。

本地记录的validUntil=null是未确认，不能被缓存逻辑当作永不过期。公开参考、货代本单报价、老板估算授权分别记录；老板已允许多来源最高可比价估算，按此标注参考和未确认项，不冒充可订舱报价。
