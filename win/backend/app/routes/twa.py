# Copyright (c) 2026 Yui_0818 (aaaj6719@gmail.com)
# Licensed under the PolyForm Noncommercial License 1.0.0.
# Commercial use is prohibited without separate written authorization.
# See LICENSE and COMMERCIAL.md in the repository root.

"""TWA（Trusted Web Activity）路由（早期设计文档）。

端点：
- GET /.well-known/assetlinks.json: 返回 Digital Asset Links JSON

TWA 必须验证对 PWA 域名的所有权，否则地址栏会显示。
该路由必须在 app.mount("/", StaticFiles(...)) 之前注册，否则会被静态文件拦截返回 404。

占位符说明：
- package_name: com.menstrual.app（占位，外部依赖阶段可改）
- sha256_cert_fingerprints: "PLACEHOLDER_REPLACE_WITH_REAL_SHA256"
  外部依赖阶段生成签名密钥后，用以下命令计算 SHA256 指纹并替换占位符：
  keytool -list -v -keystore release.keystore -alias release -storepass <password> | grep SHA256
"""

from fastapi import APIRouter, Response

router = APIRouter(tags=["twa"])

# Digital Asset Links JSON 内容（早期设计文档）
# 外部依赖阶段：替换 sha256_cert_fingerprints 占位符为真实签名指纹
_ASSETLINKS_JSON = (
    '[{'
    '"relation": ["delegate_permission/common.handle_all_paths"], '
    '"target": {'
    '"namespace": "android_app", '
    '"package_name": "com.menstrual.app", '
    '"sha256_cert_fingerprints": ["PLACEHOLDER_REPLACE_WITH_REAL_SHA256"]'
    '}'
    '}]'
)


@router.get("/.well-known/assetlinks.json", include_in_schema=False)
async def get_assetlinks() -> Response:
    """返回 Digital Asset Links JSON（TWA 域名所有权验证）。"""
    return Response(content=_ASSETLINKS_JSON, media_type="application/json")
