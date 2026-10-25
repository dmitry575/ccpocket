import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_windows/webview_windows.dart' as win;

import '../../theme/app_theme.dart';

/// Fork: in-app preview of an Artifact Claude published, served by the
/// bridge from the local source file (no claude.ai sign-in).
///
/// Android/iOS/macOS use webview_flutter, Windows uses WebView2; elsewhere
/// (Linux, or Windows without the WebView2 runtime) the signed bridge link
/// opens in the system browser.
class ArtifactScreen extends StatefulWidget {
  final String viewUrl;
  final String title;

  /// claude.ai link of the published artifact, if any.
  final String? publishedUrl;

  const ArtifactScreen({
    super.key,
    required this.viewUrl,
    required this.title,
    this.publishedUrl,
  });

  static Future<void> open(
    BuildContext context, {
    required String viewUrl,
    required String title,
    String? publishedUrl,
  }) {
    return Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ArtifactScreen(
          viewUrl: viewUrl,
          title: title,
          publishedUrl: publishedUrl,
        ),
      ),
    );
  }

  @override
  State<ArtifactScreen> createState() => _ArtifactScreenState();
}

enum _Engine { flutter, windows, external }

_Engine get _platformEngine {
  if (kIsWeb) return _Engine.external;
  return switch (defaultTargetPlatform) {
    TargetPlatform.android ||
    TargetPlatform.iOS ||
    TargetPlatform.macOS => _Engine.flutter,
    TargetPlatform.windows => _Engine.windows,
    _ => _Engine.external,
  };
}

class _ArtifactScreenState extends State<ArtifactScreen> {
  _Engine _engine = _platformEngine;
  WebViewController? _flutterController;
  win.WebviewController? _winController;
  StreamSubscription<win.LoadingState>? _winLoading;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _start();
  }

  Future<void> _start() async {
    switch (_engine) {
      case _Engine.flutter:
        final controller = WebViewController()
          ..setJavaScriptMode(JavaScriptMode.unrestricted)
          ..setNavigationDelegate(
            NavigationDelegate(
              onPageFinished: (_) {
                if (mounted) setState(() => _loading = false);
              },
              onWebResourceError: (error) {
                if (error.isForMainFrame == true && mounted) {
                  setState(() {
                    _loading = false;
                    _error = error.description;
                  });
                }
              },
            ),
          );
        _flutterController = controller;
        await controller.loadRequest(Uri.parse(widget.viewUrl));
      case _Engine.windows:
        try {
          if (await win.WebviewController.getWebViewVersion() == null) {
            throw StateError('WebView2 runtime is not installed');
          }
          final controller = win.WebviewController();
          await controller.initialize();
          _winLoading = controller.loadingState.listen((state) {
            if (state == win.LoadingState.navigationCompleted && mounted) {
              setState(() => _loading = false);
            }
          });
          await controller.loadUrl(widget.viewUrl);
          if (!mounted) {
            controller.dispose();
            return;
          }
          setState(() => _winController = controller);
        } catch (_) {
          if (mounted) setState(() => _engine = _Engine.external);
          await _openExternally(widget.viewUrl);
        }
      case _Engine.external:
        await _openExternally(widget.viewUrl);
    }
  }

  Future<void> _openExternally(String url) async {
    final ok = await launchUrl(
      Uri.parse(url),
      mode: LaunchMode.externalApplication,
    );
    if (mounted) {
      setState(() {
        _loading = false;
        if (!ok) _error = 'Could not open the browser.';
      });
    }
  }

  Future<void> _reload() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    switch (_engine) {
      case _Engine.flutter:
        await _flutterController?.reload();
      case _Engine.windows:
        await _winController?.reload();
      case _Engine.external:
        await _openExternally(widget.viewUrl);
    }
  }

  @override
  void dispose() {
    _winLoading?.cancel();
    _winController?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final appColors = Theme.of(context).extension<AppColors>()!;
    final published = widget.publishedUrl;
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.title, overflow: TextOverflow.ellipsis),
        actions: [
          IconButton(
            tooltip: 'Reload',
            icon: const Icon(Icons.refresh),
            onPressed: _reload,
          ),
          PopupMenuButton<String>(
            tooltip: 'More',
            onSelected: (value) => switch (value) {
              'browser' => _openExternally(widget.viewUrl),
              'claude' when published != null => _openExternally(published),
              _ => null,
            },
            itemBuilder: (_) => [
              const PopupMenuItem(
                value: 'browser',
                child: Text('Open in browser (no sign-in)'),
              ),
              if (published != null)
                const PopupMenuItem(
                  value: 'claude',
                  child: Text('Open on claude.ai'),
                ),
            ],
          ),
        ],
        bottom: _loading
            ? const PreferredSize(
                preferredSize: Size.fromHeight(2),
                child: LinearProgressIndicator(minHeight: 2),
              )
            : null,
      ),
      body: _buildBody(appColors),
    );
  }

  Widget _buildBody(AppColors appColors) {
    final error = _error;
    if (error != null) {
      return _Message(
        icon: Icons.error_outline,
        text: error,
        appColors: appColors,
      );
    }
    switch (_engine) {
      case _Engine.flutter:
        final controller = _flutterController;
        return controller == null
            ? const SizedBox.shrink()
            : WebViewWidget(controller: controller);
      case _Engine.windows:
        final controller = _winController;
        return controller == null ? const SizedBox.shrink() : win.Webview(controller);
      case _Engine.external:
        return _Message(
          icon: Icons.open_in_browser,
          text:
              'The artifact opened in your browser. The link works without '
              'signing in and expires in two hours.',
          appColors: appColors,
        );
    }
  }
}

class _Message extends StatelessWidget {
  final IconData icon;
  final String text;
  final AppColors appColors;

  const _Message({
    required this.icon,
    required this.text,
    required this.appColors,
  });

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 32, color: appColors.subtleText),
            const SizedBox(height: 12),
            Text(
              text,
              textAlign: TextAlign.center,
              style: TextStyle(color: appColors.subtleText),
            ),
          ],
        ),
      ),
    );
  }
}
