package com.lyrnox.edgessh.apk

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Bundle
import android.util.Log
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * EdgeSSH 网站的 Android 打包版：
 *
 * - 前端代码（HTML/CSS/JS）构建自仓库源码，打包在 APK 的 assets/web/ 里。
 * - WebView 加载 https://ssh.lyrnox.com/，但所有页面资源拦截后走本地 assets，
 *   只有 /api/ 开头的请求代理到真实后端。前端看到的 origin 就是真实域名，
 *   origin 校验、WebSocket 直连后端，无需任何 hack。
 * - 服务器数据来自真实后端 D1，打开即与网站一致。
 * - Cloudflare Access 登录在 WebView 内完成，Cookie 持久保存。
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView
    private val cookieManager = CookieManager.getInstance()

    companion object {
        private const val TAG = "EdgeSSH"
        private const val BACKEND = "https://ssh.lyrnox.com"
        private const val HOME_URL = "$BACKEND/"
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        cookieManager.setAcceptCookie(true)

        webView = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                mediaPlaybackRequiresUserGesture = false
                cacheMode = WebSettings.LOAD_DEFAULT
            }
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView?,
                    request: WebResourceRequest?
                ): WebResourceResponse? {
                    val url = request?.url ?: return null
                    if (url.host != "ssh.lyrnox.com") return null
                    val path = url.path.orEmpty()
                    return if (path.startsWith("/api/")) {
                        proxyApi(request)
                    } else {
                        serveLocal(path)
                    }
                }

                override fun shouldOverrideUrlLoading(
                    view: WebView?, request: WebResourceRequest?
                ): Boolean = false
            }
            webChromeClient = WebChromeClient()
        }
        setContentView(webView)

        if (savedInstanceState == null) webView.loadUrl(HOME_URL)
        else webView.restoreState(savedInstanceState)
    }

    /** 页面静态资源走 APK 本地 assets/web/ */
    private fun serveLocal(path: String): WebResourceResponse? {
        return try {
            val assetPath = "web" + (if (path == "/") "/index.html" else path)
            val stream: InputStream = assets.open(assetPath)
            val mime = when {
                assetPath.endsWith(".html") -> "text/html"
                assetPath.endsWith(".js") -> "text/javascript"
                assetPath.endsWith(".css") -> "text/css"
                assetPath.endsWith(".svg") -> "image/svg+xml"
                assetPath.endsWith(".json") -> "application/json"
                assetPath.endsWith(".png") -> "image/png"
                assetPath.endsWith(".ico") -> "image/x-icon"
                else -> "application/octet-stream"
            }
            WebResourceResponse(mime, "utf-8", 200, "OK", emptyMap(), stream)
        } catch (e: Exception) {
            // 本地没有（如 source map），放行走网络
            null
        }
    }

    /** /api/ 开头的请求代理到真实后端，带上 Access Cookie；未登录则跳登录页 */
    private fun proxyApi(request: WebResourceRequest): WebResourceResponse? {
        return try {
            val path = request.url.path.orEmpty()
            val query = if (request.url.query.isNullOrEmpty()) "" else "?${request.url.query}"
            val conn = (URL("$BACKEND$path$query").openConnection() as HttpURLConnection).apply {
                requestMethod = request.method
                connectTimeout = 15000
                readTimeout = 30000
                instanceFollowRedirects = false
                cookieManager.getCookie(BACKEND)?.let {
                    if (it.isNotEmpty()) setRequestProperty("Cookie", it)
                }
                for ((key, value) in request.requestHeaders) {
                    if (!key.equals("Cookie", ignoreCase = true) &&
                        !key.equals("Host", ignoreCase = true)) {
                        setRequestProperty(key, value)
                    }
                }
            }
            val code = conn.responseCode
            if (code in listOf(301, 302, 303, 307, 308)) {
                val loc = conn.getHeaderField("Location").orEmpty()
                if (loc.contains("cloudflareaccess.com")) {
                    runOnUiThread { webView.loadUrl(loc) }
                    return textResponse(401, "Login required")
                }
            }
            conn.headerFields["Set-Cookie"]?.forEach { cookieManager.setCookie(BACKEND, it) }
            val stream = if (code >= 400) conn.errorStream else conn.inputStream
            val mime = conn.contentType?.substringBefore(";") ?: "application/octet-stream"
            WebResourceResponse(mime, "utf-8", code, conn.responseMessage ?: "",
                emptyMap(), stream ?: ByteArrayInputStream(ByteArray(0)))
        } catch (e: Exception) {
            Log.e(TAG, "proxyApi failed", e)
            null
        }
    }

    private fun textResponse(code: Int, text: String): WebResourceResponse =
        WebResourceResponse("text/plain", "utf-8", code, "",
            emptyMap(), ByteArrayInputStream(text.toByteArray()))

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webView.url?.contains("cloudflareaccess.com") == true) {
            webView.loadUrl(HOME_URL)
        } else if (webView.canGoBack()) webView.goBack()
        else super.onBackPressed()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }
    override fun onPause() { super.onPause(); webView.onPause() }
    override fun onResume() { super.onResume(); webView.onResume() }
    override fun onDestroy() { webView.destroy(); super.onDestroy() }
}
