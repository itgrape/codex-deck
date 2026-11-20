# Codex 容器运行权限

Compose 的 `security_opt` 仅作用于 `codex-deck` 服务，不修改 Docker daemon 或其他容器的默认配置。启动或重建服务即可加载：

```bash
docker compose up -d --build
```

直接使用 Docker 时，在项目根目录执行（另按需要添加环境变量、端口和数据挂载）：

```bash
docker run --rm \
  --security-opt seccomp=./docker/codex-seccomp.json \
  --security-opt no-new-privileges=true \
  codex-deck:local npm run smoke:native
```

`codex-seccomp.json` 基于 [Moby 官方默认策略](https://github.com/moby/profiles/blob/2ab3e516a3b49550c35b5e4511a0a7d136a02c8d/seccomp/default.json)，保留原有规则并新增：

- `clone`：只额外允许包含 `CLONE_NEWUSER` 的调用，兼容 s390 参数顺序。
- `unshare`、`setns`、`mount`、`umount2`、`pivot_root`、`sethostname`：供 bubblewrap 设置嵌套 namespace，内核仍执行用户身份和 capability 检查。

这会扩大该容器可用的 namespace / mount 系统调用范围，不关闭整个 seccomp，不使用 privileged，不添加 SYS_ADMIN，不关闭 AppArmor，也不挂载 Docker socket。容器继续使用镜像中的非 root `node` 用户。默认策略的 Apache-2.0 许可证见 [SECCOMP-LICENSE](SECCOMP-LICENSE)。

本机 Linux ARM64 / OrbStack 容器已验证：原生 app server 初始化、线程和技能列表、只读命令执行、只读写入拒绝及工作区写入成功；不调用模型。其他宿主机的内核、rootless 或 AppArmor 策略仍可能另有限制，可运行上面的 smoke 命令检查；不要据此自动放开宿主机或其他容器权限。
