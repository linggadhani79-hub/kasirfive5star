package com.five5star.kasir

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.print.PrintAttributes
import android.print.PrintManager
import android.speech.tts.TextToSpeech
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.util.Locale

/**
 * Pembungkus WebView untuk aplikasi kasir Five5Star (Cloudflare Workers).
 * - Mode layar penuh & layar tidak mati (tablet meja, barista, monitor antrean)
 * - Jembatan JavaScript "AndroidBridge": suara TextToSpeech bahasa Indonesia & cetak struk
 * - Alamat server bisa diganti dari menu tombol Kembali
 */
class MainActivity : AppCompatActivity(), TextToSpeech.OnInitListener {

    private lateinit var webView: WebView
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private val pendingSpeech = mutableListOf<Pair<String, Float>>()
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    private val prefs by lazy { getSharedPreferences("five5star", Context.MODE_PRIVATE) }
    private var serverUrl: String
        get() = prefs.getString("server_url", BuildConfig.DEFAULT_SERVER_URL) ?: ""
        set(v) = prefs.edit().putString("server_url", v).apply()

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        enterImmersive()

        webView = WebView(this)
        setContentView(FrameLayout(this).apply { addView(webView) })

        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false // monitor antrean bisa bunyi tanpa disentuh
            cacheMode = WebSettings.LOAD_DEFAULT
            loadWithOverviewMode = true
            useWideViewPort = true
            setSupportZoom(false)
            builtInZoomControls = false
            userAgentString = "$userAgentString Five5StarAndroid/${BuildConfig.VERSION_NAME}"
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        webView.addJavascriptInterface(Bridge(), "AndroidBridge")
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                val base = Uri.parse(serverUrl)
                // Tautan ke domain lain dibuka di browser
                return if (url.host != null && url.host != base.host) {
                    startActivity(Intent(Intent.ACTION_VIEW, url)); true
                } else false
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) showOffline(error.description?.toString() ?: "")
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) = Unit
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean = true

            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return try {
                    startActivityForResult(params.createIntent(), REQ_FILE); true
                } catch (e: Exception) {
                    fileCallback = null; false
                }
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else showMenu()
            }
        })

        tts = TextToSpeech(this, this)

        if (savedInstanceState != null) webView.restoreState(savedInstanceState)
        else if (serverUrl.isBlank()) askServerUrl(first = true)
        else webView.loadUrl(serverUrl)
    }

    private fun enterImmersive() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) enterImmersive()
    }

    private fun showMenu() {
        AlertDialog.Builder(this)
            .setTitle("Five5Star Kasir")
            .setItems(arrayOf("Muat ulang", "Pilih mode perangkat", "Ganti alamat server", "Keluar aplikasi")) { _, which ->
                when (which) {
                    0 -> webView.reload()
                    1 -> webView.loadUrl(serverUrl.trimEnd('/') + "/?pilih=1")
                    2 -> askServerUrl(first = false)
                    3 -> finish()
                }
            }
            .show()
    }

    private fun askServerUrl(first: Boolean) {
        val input = EditText(this).apply {
            hint = "https://kasir-five5star.akun.workers.dev"
            setText(serverUrl)
            setSingleLine()
        }
        AlertDialog.Builder(this)
            .setTitle("Alamat server")
            .setMessage("Masukkan alamat aplikasi kasir (URL Cloudflare Workers).")
            .setView(input)
            .setCancelable(!first)
            .setPositiveButton("Simpan") { _, _ ->
                var url = input.text.toString().trim()
                if (url.isNotEmpty() && !url.startsWith("http")) url = "https://$url"
                if (url.isEmpty()) {
                    Toast.makeText(this, "Alamat wajib diisi", Toast.LENGTH_SHORT).show()
                    askServerUrl(first)
                } else {
                    serverUrl = url
                    webView.loadUrl(url)
                }
            }
            .show()
    }

    private fun showOffline(reason: String) {
        val html = """
            <html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
            <body style="background:#22150e;color:#f6efe6;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center">
            <div><div style="font-size:64px">☕</div><h2>Tidak dapat terhubung</h2>
            <p style="opacity:.7">Periksa koneksi internet / Wi-Fi.<br><small>${reason.replace("<", "")}</small></p>
            <button onclick="location.href='${serverUrl.replace("'", "")}'" style="font-size:18px;padding:14px 28px;border-radius:12px;border:0;background:#d29b2e">Coba lagi</button>
            <p style="opacity:.6;font-size:13px;margin-top:24px">Tekan tombol Kembali untuk mengganti alamat server.</p></div>
            <script>setTimeout(function(){location.href='${serverUrl.replace("'", "")}'},15000)</script></body></html>
        """.trimIndent()
        webView.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
    }

    // ---------- TextToSpeech ----------
    override fun onInit(status: Int) {
        if (status != TextToSpeech.SUCCESS) return
        val engine = tts ?: return
        val id = Locale("id", "ID")
        val res = engine.setLanguage(id)
        if (res == TextToSpeech.LANG_MISSING_DATA || res == TextToSpeech.LANG_NOT_SUPPORTED) {
            runOnUiThread {
                Toast.makeText(this, "Suara Bahasa Indonesia belum terpasang. Buka Setelan > Text-to-speech untuk mengunduhnya.", Toast.LENGTH_LONG).show()
            }
        }
        ttsReady = true
        synchronized(pendingSpeech) {
            pendingSpeech.forEach { (t, r) -> speakNow(t, r) }
            pendingSpeech.clear()
        }
    }

    private fun speakNow(text: String, rate: Float) {
        tts?.setSpeechRate(rate.coerceIn(0.5f, 1.5f))
        tts?.speak(text, TextToSpeech.QUEUE_ADD, null, "f5-${System.nanoTime()}")
    }

    inner class Bridge {
        @JavascriptInterface
        fun speak(text: String, rate: Double) {
            if (ttsReady) speakNow(text, rate.toFloat())
            else synchronized(pendingSpeech) { pendingSpeech.add(text to rate.toFloat()) }
        }

        @JavascriptInterface
        fun stopSpeaking() {
            tts?.stop()
        }

        @JavascriptInterface
        fun isAndroid(): Boolean = true

        @JavascriptInterface
        fun print() {
            runOnUiThread {
                val pm = getSystemService(Context.PRINT_SERVICE) as PrintManager
                val adapter = webView.createPrintDocumentAdapter("Struk Five5Star")
                pm.print("Struk Five5Star", adapter, PrintAttributes.Builder().build())
            }
        }

        @JavascriptInterface
        fun openSettings() {
            runOnUiThread { showMenu() }
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_FILE) {
            fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
            fileCallback = null
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onDestroy() {
        tts?.shutdown()
        webView.destroy()
        super.onDestroy()
    }

    companion object {
        private const val REQ_FILE = 42
    }
}
