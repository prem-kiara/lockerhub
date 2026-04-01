package com.dhanam.lockerhub

import android.app.Application
import com.google.firebase.crashlytics.FirebaseCrashlytics

class LockerHubApp : Application() {
    override fun onCreate() {
        super.onCreate()

        // Enable Crashlytics (disable in debug builds to avoid noise)
        val isDebug = (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
        FirebaseCrashlytics.getInstance().setCrashlyticsCollectionEnabled(!isDebug)
    }
}
