package com.gridcross.app;

import android.graphics.Color;
import android.os.Bundle;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.InputMethodManager;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.LinearLayout;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;
import com.google.android.gms.ads.AdRequest;
import com.google.android.gms.ads.AdSize;
import com.google.android.gms.ads.AdView;
import com.google.android.gms.ads.MobileAds;

public class MainActivity extends BridgeActivity {
    private FrameLayout adContainer;
    private AdView adView;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        setupBannerAd();

        // targetSdk 35+(안드로이드 15+)에서는 앱이 상태바/내비게이션바 뒤까지 그려지는 edge-to-edge가 기본이라,
        // 웹뷰(광고 배너, 하단 링크)가 시스템 바와 겹침 → 시스템 바 크기만큼 여백을 줘서 그 안쪽에서만 그리게 한다.
        View content = findViewById(android.R.id.content);
        ViewCompat.setOnApplyWindowInsetsListener(content, (v, insets) -> {
            Insets bars = insets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            // 키보드가 올라오면 키보드 높이만큼 아래 여백을 키워 입력창이 가려지지 않게 함
            v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            // 키보드가 열려 있을 땐 배너가 키보드 바로 위에서 입력 화면을 좁히지 않도록 숨김
            adContainer.setVisibility(ime.bottom > 0 ? View.GONE : View.VISIBLE);
            return WindowInsetsCompat.CONSUMED;
        });

        // 사이트가 어두운 배경이라 상태바/내비바 아이콘은 밝은 색으로
        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.setAppearanceLightStatusBars(false);
        controller.setAppearanceLightNavigationBars(false);

        // 웹뷰가 "포커스가 새로 옮겨가는 첫 탭"에서 키보드 요청을 빠뜨리는 경우가 있어(같은 칸을 한 번 더 눌러야 뜸),
        // 입력칸을 탭했는데 키보드가 안 떠 있으면 직접 띄워준다. 터치 이벤트는 소비하지 않음.
        WebView webView = getBridge().getWebView();
        webView.setOnTouchListener((v, event) -> {
            if (event.getAction() == MotionEvent.ACTION_UP) {
                v.postDelayed(() -> {
                    WebView.HitTestResult hit = webView.getHitTestResult();
                    if (hit == null || hit.getType() != WebView.HitTestResult.EDIT_TEXT_TYPE) return;
                    WindowInsetsCompat root = ViewCompat.getRootWindowInsets(webView);
                    if (root != null && root.isVisible(WindowInsetsCompat.Type.ime())) return;
                    InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
                    if (imm != null) imm.showSoftInput(webView, InputMethodManager.SHOW_IMPLICIT);
                }, 200);
            }
            return false;
        });
    }

    // 웹(사이트)에서는 카카오 애드핏을 쓰지만 앱 안에서는 숨기고(territory_game_online.html의 native-app),
    // 대신 웹뷰 위(기존 애드핏 자리)에 AdMob 적응형 배너를 붙인다. 웹뷰를 세로 LinearLayout으로 감싸 배너와 겹치지 않게 함.
    private void setupBannerAd() {
        WebView webView = getBridge().getWebView();
        ViewGroup parent = (ViewGroup) webView.getParent();
        int index = parent.indexOfChild(webView);
        ViewGroup.LayoutParams webViewParams = webView.getLayoutParams();
        parent.removeView(webView);

        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        adContainer = new FrameLayout(this);
        adContainer.setBackgroundColor(Color.parseColor("#0d1117")); // 사이트 배경색(--bg)
        column.addView(adContainer, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        column.addView(webView, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        parent.addView(column, index, webViewParams);

        new Thread(() -> MobileAds.initialize(this, status -> {})).start();

        // 적응형 배너는 실제 가로 폭(dp)이 필요하므로 레이아웃이 잡힌 뒤에 크기를 계산해서 로드
        adContainer.post(() -> {
            DisplayMetrics metrics = getResources().getDisplayMetrics();
            int widthPx = adContainer.getWidth() > 0 ? adContainer.getWidth() : metrics.widthPixels;
            int widthDp = (int) (widthPx / metrics.density);
            adView = new AdView(this);
            adView.setAdUnitId(getString(R.string.admob_banner_id));
            adView.setAdSize(AdSize.getCurrentOrientationAnchoredAdaptiveBannerAdSize(this, widthDp));
            adContainer.addView(adView, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                    Gravity.CENTER_HORIZONTAL));
            adView.loadAd(new AdRequest.Builder().build());
        });
    }

    @Override
    public void onPause() {
        if (adView != null) adView.pause();
        super.onPause();
    }

    @Override
    public void onResume() {
        super.onResume();
        if (adView != null) adView.resume();
    }

    @Override
    public void onDestroy() {
        if (adView != null) adView.destroy();
        super.onDestroy();
    }
}
