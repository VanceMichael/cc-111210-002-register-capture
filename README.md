# 岸桥寄存器映射的成组一致采样

本项目用于授权资料接入的单次查看与接收留存，使用 Node.js 22。来源协议见 `docs/source-contract.md`。本地演练服务只绑定回环地址，数据不含真实个人资料或账号。

## 安装与运行

依赖由 `package-lock.json` 固定。首次准备环境运行 `npm ci --ignore-scripts`，浏览器项目使用 Playwright 1.56.1 对应的 Chromium；浏览器及系统库在镜像准备阶段安装，不在业务命令中下载。

```sh
npm run build
npm test
npm run demo
npm start
```

`npm run demo` 启动本地来源和接入服务，先演示现场保留的单段查看，再演示请求规划与一次成组一致采样，显示完整 JSON，随后关闭服务并清理临时目录。通常在十秒内结束。`npm start` 启动常驻服务，默认端口3000，可通过 PORT 与 DATA_DIR 修改监听端口和接收目录。设置 SOURCE_URL 可连接另一进程中已启动的本地来源；不设置时自动创建演练来源。设置 AUTO_START=1 让服务启动后按 INTERVAL_MS（默认 2000ms）自动成组采集，MAX_FRAME_RETRIES（默认 2）控制换帧后的最大重采次数。恢复演练可先用 `npm run source` 在另一终端启动来源，记下输出地址，保持该进程运行，仅重启设置了 SOURCE_URL 的接入服务。

## 接口与模块

`GET /health` 查看状态，`GET /inspect` 查看来源，`GET /receive?key=sample` 保存单次接收，`GET /receipts/sample` 读取回执。相同key和相同内容可重复接收，不同内容拒绝覆盖。

成组一致采样新增：`GET /plan` 查看请求规划（分组、帧前后读、按最大字数与禁读空洞拆段），`POST /collect/once` 执行一个采集周期，`POST /collect/start|stop` 常驻启停，`GET /collect/status` 查看质量统计与中断恢复信息，`GET /mapping`、`POST /mapping`、`GET /mapping/refresh` 管理映射与组边界热切换，`GET /records` 与 `GET /records/:id` 读取可追溯到映射版本、内容摘要和原始字的成组记录。协议与质量标志语义见 `docs/source-contract.md`。

`src/mapping.mjs` 在加载阶段整体校验映射并生成请求规划，坏映射直接拒绝；`src/decoder.mjs` 按映射处理符号、缩放、位字段、字序与字节序；`src/gateway.mjs` 封装网关读并区分离线与其他错误；`src/collector.mjs` 用帧号前后读保证同帧一致，换帧只重采该组，耗尽重采输出质量标志而不补旧值，并在组边界完成映射热切换；`src/journal.mjs` 原子记录周期进度，崩溃重启后把未完成组定性为中断并整组重采；`src/records.mjs` 持久化成组记录。`fixtures/source.mjs` 提供可重复启动的本地来源，`src/service.mjs` 组织访问入口，`src/store.mjs` 保存单段查看结果。`test/` 下覆盖规划、解码、换帧重试、离线隔离、热切换、漂移保护与重启恢复。

生产接入地址与凭据需由部署配置给出；演练客户端拒绝访问回环以外的地址。文档中的接口不向外提供任意目标代理。异常以明确错误响应返回，接收失败不覆盖原回执。
