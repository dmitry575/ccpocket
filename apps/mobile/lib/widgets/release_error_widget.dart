import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

import '../l10n/app_localizations.dart';

Locale? _releaseErrorLocaleOverride;

@visibleForTesting
String releaseErrorMessageForLocale(Locale locale) {
  final languageCode =
      AppLocalizations.supportedLocales.any(
        (supported) => supported.languageCode == locale.languageCode,
      )
      ? locale.languageCode
      : 'en';
  return lookupAppLocalizations(Locale(languageCode)).renderErrorFallback;
}

void updateReleaseErrorWidgetLocale(Locale? locale) {
  _releaseErrorLocaleOverride = locale;
}

/// Short, single-line description of the failure for the fork's error box.
/// Upstream hides details in release builds; a self-hosted single user is
/// better served by seeing what broke so it can be reported and fixed.
@visibleForTesting
String releaseErrorDetail(FlutterErrorDetails details) {
  final text = details.exceptionAsString().replaceAll(RegExp(r'\s+'), ' ').trim();
  const limit = 240;
  final clipped = text.length > limit ? '${text.substring(0, limit)}…' : text;
  final library = details.library;
  return library == null || library.isEmpty ? clipped : '$clipped ($library)';
}

@visibleForTesting
Widget buildReleaseErrorWidget(FlutterErrorDetails details) {
  final locale =
      _releaseErrorLocaleOverride ??
      WidgetsBinding.instance.platformDispatcher.locale;
  return ReleaseErrorWidget(
    message: releaseErrorMessageForLocale(locale),
    detail: releaseErrorDetail(details),
  );
}

void installReleaseErrorWidget({bool isReleaseMode = kReleaseMode}) {
  if (!isReleaseMode) return;
  ErrorWidget.builder = buildReleaseErrorWidget;
}

class ReleaseErrorWidget extends LeafRenderObjectWidget {
  ReleaseErrorWidget({required this.message, this.detail})
    : super(key: UniqueKey());

  final String message;

  /// Failure summary painted under [message]; absent in upstream builds.
  final String? detail;

  @override
  RenderBox createRenderObject(BuildContext context) {
    final detail = this.detail;
    return _RenderReleaseErrorBox(
      detail == null || detail.isEmpty ? message : '$message\n$detail',
    );
  }

  @override
  void debugFillProperties(DiagnosticPropertiesBuilder properties) {
    super.debugFillProperties(properties);
    properties.add(StringProperty('message', message));
  }
}

class _RenderReleaseErrorBox extends RenderErrorBox {
  _RenderReleaseErrorBox(super.message);

  /// Upstream's RenderErrorBox takes the biggest size allowed; inside a
  /// scrollable that is ~100k pixels of grey that scrolls forever. Keep the
  /// box to a readable strip instead.
  static const double _maxHeight = 160;
  static const double _fallbackWidth = 400;

  @override
  void performLayout() {
    size = constraints.constrain(
      Size(
        constraints.hasBoundedWidth ? constraints.maxWidth : _fallbackWidth,
        _maxHeight,
      ),
    );
  }

  @override
  void describeSemanticsConfiguration(SemanticsConfiguration config) {
    super.describeSemanticsConfiguration(config);
    config
      ..isSemanticBoundary = true
      ..label = message
      ..textDirection = TextDirection.ltr;
  }
}
