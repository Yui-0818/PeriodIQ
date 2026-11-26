/*
 * Copyright (c) 2026 Yui_0818 (aaaj6719@gmail.com)
 * Licensed under the PolyForm Noncommercial License 1.0.0.
 * Commercial use is prohibited without separate written authorization.
 * See LICENSE and COMMERCIAL.md in the repository root.
 */

package io.github.yui0818.periodiq.api.contract

import org.json.JSONObject

/** 业务异常（等价于桌面的 `HTTPException(detail={detail, code})`）。 */
class ApiError(
    val status: Int,
    val detail: String,
    val code: String,
    val extra: JSONObject? = null,
) : RuntimeException("$code: $detail")
