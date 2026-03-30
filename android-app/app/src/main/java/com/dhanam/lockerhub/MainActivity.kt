package com.dhanam.lockerhub

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Message
import android.view.KeyEvent
import android.view.View
import android.webkit.*
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout

class MainActivity : AppCompatActivity() {

    companion object {
        private const val BASE_URL = "https://lockers.dhanamfinance.com"
        private const val TAG = "LockerHub"
    }

    private lateinit var webView: WebView
    private lateinit var swipeRefresh: SwipeRefreshLayout
    private lateinit var offlineView: View
    private lateinit var contentView: FrameLayout

    private var fileUploadCallback: ValueCallback<Array<Uri>>? = null
    private lateinit var fileChooserLauncher: ActivityResultLauncher<Intent>
    private lateinit var cameraPermissionLauncher: ActivityResultLauncher<String>

    private var isLoading = true  // Keep splash screen while loading

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        // Splash screen (shown while app loads)
        val splashScreen = installSplashScreen()
        splashScreen.setKeepOnScreenCondition { isLoading }

        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        // Views
        contentView = findViewById(R.id.content_frame)
        webView = findViewById(R.id.webview)
        swipeRefresh = findViewById(R.id.swipe_refresh)
        offlineView = findViewById(R.id.offline_view)

        // File upload launcher
        fileChooserLauncher = registerForActivityResult(
            ActivityResultContracts.StartActivityForResult()
        ) { result ->
            val data = if (result.resultCode == Activity.RESULT_OK) result.data else null
            val results = if (data?.data != null) arrayOf(data.data!!) else null
            fileUploadCallback?.onReceiveValue(results)
            fileUploadCallback = null
        }

        // Camera permission launcher
        cameraPermissionLauncher = registerForActivityResult(
            ActivityResultContracts.RequestPermission()
        ) { /* Permission result handled, file chooser will check again */ }

        // Pull-to-refresh — only when page is scrolled to top
        swipeRefresh.setColorSchemeColors(
            ContextCompat.getColor(this, R.color.gold_primary)
        )
        swipeRefresh.setOnRefreshListener {
            if (isOnline()) {
                webView.reload()
            } else {
                swipeRefresh.isRefreshing = false
                showOffline()
            }
        }

        // Disable pull-to-refresh when WebView content is not at the top
        // This prevents SwipeRefreshLayout from stealing touch events from scrollable elements (sidebar, modals)
        webView.setOnScrollChangeListener { _, _, scrollY, _, _ ->
            swipeRefresh.isEnabled = scrollY == 0
        }

        // Offline retry button
        findViewById<View>(R.id.btn_retry).setOnClickListener {
            if (isOnline()) {
                hideOffline()
                webView.loadUrl(BASE_URL)
            } else {
                Toast.makeText(this, "Still no internet connection", Toast.LENGTH_SHORT).show()
            }
        }

        setupWebView()

        // Load the app
        if (isOnline()) {
            webView.loadUrl(BASE_URL)
        } else {
            isLoading = false
            showOffline()
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = true
            allowContentAccess = true
            loadWithOverviewMode = true
            useWideViewPort = true
            setSupportMultipleWindows(false)
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            cacheMode = if (isOnline()) {
                WebSettings.LOAD_DEFAULT
            } else {
                WebSettings.LOAD_CACHE_ELSE_NETWORK
            }

            // Modern user agent
            userAgentString = "$userAgentString LockerHub-Android/1.0"
        }

        webView.webViewClient = object : WebViewClient() {

            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                super.onPageStarted(view, url, favicon)
                swipeRefresh.isRefreshing = true
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                isLoading = false
                swipeRefresh.isRefreshing = false
                hideOffline()
            }

            override fun onReceivedError(
                view: WebView?, request: WebResourceRequest?, error: WebResourceError?
            ) {
                super.onReceivedError(view, request, error)
                // Only handle main frame errors
                if (request?.isForMainFrame == true) {
                    isLoading = false
                    swipeRefresh.isRefreshing = false
                    showOffline()
                }
            }

            override fun shouldOverrideUrlLoading(
                view: WebView?, request: WebResourceRequest?
            ): Boolean {
                val url = request?.url?.toString() ?: return false

                // Keep navigation within our domain inside the WebView
                if (url.startsWith(BASE_URL) || url.contains("dhanamfinance.com")) {
                    return false
                }

                // Open external links (payment gateways, etc.) in browser
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                } catch (e: Exception) {
                    Toast.makeText(this@MainActivity, "Cannot open link", Toast.LENGTH_SHORT).show()
                }
                return true
            }
        }

        webView.webChromeClient = object : WebChromeClient() {

            // File upload support (for documents, photos, etc.)
            override fun onShowFileChooser(
                view: WebView?,
                callback: ValueCallback<Array<Uri>>?,
                params: FileChooserParams?
            ): Boolean {
                fileUploadCallback?.onReceiveValue(null)
                fileUploadCallback = callback

                try {
                    val intent = params?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                        type = "*/*"
                        addCategory(Intent.CATEGORY_OPENABLE)
                    }
                    fileChooserLauncher.launch(intent)
                } catch (e: Exception) {
                    fileUploadCallback?.onReceiveValue(null)
                    fileUploadCallback = null
                    Toast.makeText(this@MainActivity, "Cannot open file chooser", Toast.LENGTH_SHORT).show()
                    return false
                }
                return true
            }

            // Handle JavaScript alerts
            override fun onJsAlert(
                view: WebView?, url: String?, message: String?, result: JsResult?
            ): Boolean {
                return super.onJsAlert(view, url, message, result)
            }

            // Handle JavaScript confirm dialogs
            override fun onJsConfirm(
                view: WebView?, url: String?, message: String?, result: JsResult?
            ): Boolean {
                return super.onJsConfirm(view, url, message, result)
            }
        }

        // Enable remote debugging in debug builds
        val isDebug = (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
        WebView.setWebContentsDebuggingEnabled(isDebug)
    }

    // ── Back button handling ──────────────────────────────────────────
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        when {
            // If WebView can go back, navigate back within the app
            webView.canGoBack() -> webView.goBack()
            // Otherwise, default behavior (exit app)
            else -> @Suppress("DEPRECATION") super.onBackPressed()
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView.canGoBack()) {
            webView.goBack()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    // ── Network helpers ──────────────────────────────────────────────
    private fun isOnline(): Boolean {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val network = cm.activeNetwork ?: return false
        val capabilities = cm.getNetworkCapabilities(network) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    private fun showOffline() {
        offlineView.visibility = View.VISIBLE
        webView.visibility = View.GONE
    }

    private fun hideOffline() {
        offlineView.visibility = View.GONE
        webView.visibility = View.VISIBLE
    }

    // ── Lifecycle ────────────────────────────────────────────────────
    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onPause() {
        webView.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}
