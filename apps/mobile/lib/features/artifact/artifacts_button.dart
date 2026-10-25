import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../services/bridge_service.dart';
import '../../theme/app_theme.dart';
import 'artifact_screen.dart';

String artifactTitle(Map<String, dynamic> a) {
  for (final key in ['title', 'description', 'fileName']) {
    final value = a[key];
    if (value is String && value.trim().isNotEmpty) return value.trim();
  }
  return 'Artifact';
}

/// Open the artifact a given Artifact tool call published (chat card).
Future<void> openSessionArtifact(
  BuildContext context, {
  required String sessionId,
  required String toolUseId,
}) async {
  final messenger = ScaffoldMessenger.maybeOf(context);
  final result = await context.read<BridgeService>().fetchArtifacts(sessionId);
  if (!context.mounted) return;
  Map<String, dynamic>? found;
  for (final a in result.artifacts) {
    final ids = a['toolUseIds'];
    if (ids is List && ids.contains(toolUseId)) found = a;
  }
  if (found == null) {
    messenger?.showSnackBar(
      SnackBar(
        content: Text(
          result.status == 404
              ? 'Update the bridge to preview artifacts in the app.'
              : 'This artifact was not published (or the bridge cannot see it).',
        ),
      ),
    );
    return;
  }
  await _openArtifact(context, found, messenger);
}

Future<void> _openArtifact(
  BuildContext context,
  Map<String, dynamic> a,
  ScaffoldMessengerState? messenger,
) async {
  final viewUrl = a['viewUrl'] as String?;
  final published = a['url'] as String?;
  if (viewUrl == null) {
    messenger?.showSnackBar(
      SnackBar(
        content: const Text(
          'The source file is no longer on the server; only the claude.ai '
          'copy is left.',
        ),
        action: published == null
            ? null
            : SnackBarAction(
                label: 'claude.ai',
                onPressed: () => launchUrl(
                  Uri.parse(published),
                  mode: LaunchMode.externalApplication,
                ),
              ),
      ),
    );
    return;
  }
  await ArtifactScreen.open(
    context,
    viewUrl: viewUrl,
    title: artifactTitle(a),
    publishedUrl: published,
  );
}

/// Fork: app bar button with the session's artifacts. Hidden until the
/// session published one, or when the bridge predates `/api/artifacts`.
class ArtifactsButton extends StatefulWidget {
  final String sessionId;

  const ArtifactsButton({super.key, required this.sessionId});

  @override
  State<ArtifactsButton> createState() => _ArtifactsButtonState();
}

class _ArtifactsButtonState extends State<ArtifactsButton> {
  static const _interval = Duration(seconds: 30);

  Timer? _timer;
  bool _unsupported = false;
  List<Map<String, dynamic>> _artifacts = const [];

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  @override
  void didUpdateWidget(covariant ArtifactsButton oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.sessionId != widget.sessionId) {
      _artifacts = const [];
      _unsupported = false;
      _refresh();
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _refresh() async {
    _timer?.cancel();
    final sessionId = widget.sessionId;
    final result = await context.read<BridgeService>().fetchArtifacts(
      sessionId,
    );
    if (!mounted || sessionId != widget.sessionId) return;
    if (result.status == 404) {
      setState(() => _unsupported = true);
      return;
    }
    if (result.status == 200) setState(() => _artifacts = result.artifacts);
    _timer = Timer(_interval, _refresh);
  }

  @override
  Widget build(BuildContext context) {
    if (_unsupported || _artifacts.isEmpty) return const SizedBox.shrink();
    return IconButton(
      key: const ValueKey('appbar_artifacts_button'),
      tooltip: 'Artifacts (${_artifacts.length})',
      padding: EdgeInsets.zero,
      constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
      icon: Icon(
        Icons.web_asset_outlined,
        size: 18,
        color: Theme.of(context).colorScheme.onSurfaceVariant,
      ),
      onPressed: () => _showList(context),
    );
  }

  void _showList(BuildContext context) {
    final appColors = Theme.of(context).extension<AppColors>()!;
    final messenger = ScaffoldMessenger.maybeOf(context);
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheetContext) => SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.of(sheetContext).size.height * 0.7,
          ),
          child: ListView(
            shrinkWrap: true,
            children: [
              for (final a in _artifacts)
                ListTile(
                  dense: true,
                  leading: Icon(
                    a['viewUrl'] != null
                        ? Icons.web_asset_outlined
                        : Icons.cloud_outlined,
                    size: 18,
                  ),
                  minLeadingWidth: 18,
                  title: Text(
                    artifactTitle(a),
                    overflow: TextOverflow.ellipsis,
                  ),
                  subtitle: Text(
                    [
                      a['fileName'] as String? ?? '',
                      if (a['viewUrl'] == null) 'only on claude.ai',
                      if (a['publishedAt'] is String)
                        _shortDate(a['publishedAt'] as String),
                    ].where((s) => s.isNotEmpty).join('  ·  '),
                    style: TextStyle(fontSize: 12, color: appColors.subtleText),
                  ),
                  onTap: () {
                    Navigator.of(sheetContext).pop();
                    _openArtifact(context, a, messenger);
                  },
                ),
            ],
          ),
        ),
      ),
    );
  }
}

String _shortDate(String iso) {
  final t = DateTime.tryParse(iso)?.toLocal();
  if (t == null) return '';
  String two(int v) => v.toString().padLeft(2, '0');
  return '${two(t.day)}.${two(t.month)} ${two(t.hour)}:${two(t.minute)}';
}
