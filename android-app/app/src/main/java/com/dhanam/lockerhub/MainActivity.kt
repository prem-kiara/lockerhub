package com.dhanam.lockerhub

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.view.KeyEvent
import android.view.View
import android.webkit.*
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import com.google.firebase.crashlytics.FirebaseCrashlytics
import com.google.firebase.messaging.FirebaseMessaging

class MainActivity : AppCompatActivity() {

    companion object {
        private const val BASE_URL = "https://lockers.dhanamfinance.com"
        private const val NOTIFICATION_PERMISSION_CODE = 1001
    }

    private lateinit var webView: WebView
    private lateinit var offlineView: View
    private lateinit var contentView: FrameLayout

    private var fileUploadCallback: ValueCallback<Array<Uri>>? = null
    private lateinit var fileChooserLauncher: ActivityResultLauncher<Intent>

    private var isLoading = true
    private var fcmToken: String? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        val splashScreen = installSplashScreen()
        splashScreen.setKeepOnScreenCondition { isLoading }

        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        contentView = findViewById(R.id.content_frame)
        webView = findViewById(R.id.webview)
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

        // Offline retry button
        findViewById<View>(R.id.btn_retry).setOnClickListener {
            if (isOnline()) {
                hideOffline()
                webView.loadUrl(BASE_URL)
            } else {
                Toast.makeText(this, "Still no internet connection", Toast.LENGTH_SHORT).show()
            }
        }

        // Request notification permission (Android 13+)
        requestNotificationPermission()

        // Get FCM token
        retrieveFcmToken()

        setupWebView()

        if (isOnline()) {
            webView.loadUrl(BASE_URL)
        } else {
            isLoading = false
            showOffline()
        }
    }

    // ── FCM Token ───────────────────────────────────────────────────
    private fun retrieveFcmToken() {
        // First check SharedPreferences for cached token
        val cached = getSharedPreferences("lockerhub_prefs", Context.MODE_PRIVATE)
            .getString("fcm_token", null)
        if (cached != null) {
            fcmToken = cached
        }

        // Always request fresh token from Firebase
        FirebaseMessaging.getInstance().token
            .addOnSuccessListener { token ->
                fcmToken = token
                getSharedPreferences("lockerhub_prefs", Context.MODE_PRIVATE)
                    .edit()
                    .putString("fcm_token", token)
                    .apply()
            }
            .addOnFailureListener { e ->
                FirebaseCrashlytics.getInstance().recordException(e)
            }
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                ActivityCompat.requestPermissions(
                    this,
                    arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                    NOTIFICATION_PERMISSION_CODE
                )
            }
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
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            setSupportMultipleWindows(false)
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            cacheMode = if (isOnline()) {
                WebSettings.LOAD_DEFAULT
            } else {
                WebSettings.LOAD_CACHE_ELSE_NETWORK
            }
            userAgentString = "$userAgentString LockerHub-Android/1.2"
        }

        // Add JavaScript bridge so WebView can request FCM token
        webView.addJavascriptInterface(LockerHubBridge(), "LockerHubAndroid")

        webView.webViewClient = object : WebViewClient() {

            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                super.onPageStarted(view, url, favicon)
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                isLoading = false
                hideOffline()

                // Inject FCM token availability flag into the WebView
                view?.evaluateJavascript(
                    "window.__LOCKERHUB_ANDROID__ = true; window.__FCM_READY__ = true;",
                    null
                )
            }

            override fun onReceivedError(
                view: WebView?, request: WebResourceRequest?, error: WebResourceError?
            ) {
                super.onReceivedError(view, request, error)
                // Log WebView errors to Crashlytics
                FirebaseCrashlytics.getInstance().log(
                    "WebView error: ${error?.errorCode} - ${error?.description} | URL: ${request?.url}"
                )
                if (request?.isForMainFrame == true) {
                    isLoading = false
                    showOffline()
                }
            }

            override fun shouldOverrideUrlLoading(
                view: WebView?, request: WebResourceRequest?
            ): Boolean {
                val url = request?.url?.toString() ?: return false

                if (url.startsWith(BASE_URL) || url.contains("dhanamfinance.com")) {
                    return false
                }

                try {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                } catch (e: Exception) {
                    Toast.makeText(this@MainActivity, "Cannot open link", Toast.LENGTH_SHORT).show()
                }
                return true
            }
        }

        webView.webChromeClient = object : WebChromeClient() {

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
        }

        // Download listener — handles PDF and file downloads from WebView
        webView.setDownloadListener { url, _, contentDisposition, mimeType, _ ->
            try {
                val request = DownloadManager.Request(Uri.parse(url))
                // Extract filename from Content-Disposition or URL
                val filename = URLUtil.guessFileName(url, contentDisposition, mimeType)
                request.setTitle(filename)
                request.setDescription("Downloading $filename")
                request.setMimeType(mimeType)
                request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename)

                val dm = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
                dm.enqueue(request)
                Toast.makeText(this, "Downloading $filename", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                FirebaseCrashlytics.getInstance().recordException(e)
                Toast.makeText(this, "Download failed: ${e.message}", Toast.LENGTH_LONG).show()
            }
        }

        val isDebug = (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
        WebView.setWebContentsDebuggingEnabled(isDebug)
    }

    // ── JS Bridge ───────────────────────────────────────────────────
    inner class LockerHubBridge {
        @JavascriptInterface
        fun getFcmToken(): String {
            return fcmToken ?: ""
        }

        @JavascriptInterface
        fun isAndroidApp(): Boolean {
            return true
        }
    }

    // ── Back button ─────────────────────────────────────────────────
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            @Suppress("DEPRECATION") super.onBackPressed()
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView.canGoBack()) {
            webView.goBack()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    // ── Network ─────────────────────────────────────────────────────
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

    // ── Orientation change — reset zoom ────────────────────────────
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        // Reset WebView zoom to prevent stuck-zoom on orientation change
        webView.setInitialScale(0)
        webView.evaluateJavascript(
            "document.querySelector('meta[name=viewport]').setAttribute('content','width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no');",
            null
        )
    }

    // ── Lifecycle ───────────────────────────────────────────────────
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
