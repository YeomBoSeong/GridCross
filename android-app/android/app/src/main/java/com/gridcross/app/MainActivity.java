package com.gridcross.app;

import android.os.Bundle;
import android.view.MotionEvent;
import android.view.View;
import android.view.inputmethod.InputMethodManager;
import android.webkit.WebView;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // targetSdk 35+(안드로이드 15+)에서는 앱이 상태바/내비게이션바 뒤까지 그려지는 edge-to-edge가 기본이라,
        // 웹뷰(광고 배너, 하단 링크)가 시스템 바와 겹침 → 시스템 바 크기만큼 여백을 줘서 그 안쪽에서만 그리게 한다.
        View content = findViewById(android.R.id.content);
        ViewCompat.setOnApplyWindowInsetsListener(content, (v, insets) -> {
            Insets bars = insets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            // 키보드가 올라오면 키보드 높이만큼 아래 여백을 키워 입력창이 가려지지 않게 함
            v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
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
}
