# WebView
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface

# Keep crash reporting info
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
