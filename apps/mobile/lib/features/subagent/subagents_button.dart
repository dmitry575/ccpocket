import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../services/bridge_service.dart';
import '../../theme/app_theme.dart';
import 'subagent_screen.dart';

/// Fork: app bar button listing the session's subagents, with a badge for
/// the running ones (the CLI's "N background agents" footer). Hidden until
/// the session has a subagent or when the bridge predates `/api/subagents`.
class SubagentsButton extends StatefulWidget {
  final String sessionId;

  const SubagentsButton({super.key, required this.sessionId});

  @override
  State<SubagentsButton> createState() => _SubagentsButtonState();
}

class _SubagentsButtonState extends State<SubagentsButton> {
  static const _interval = Duration(seconds: 5);

  Timer? _timer;
  bool _unsupported = false;
  List<Map<String, dynamic>> _agents = const [];

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  @override
  void didUpdateWidget(covariant SubagentsButton oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.sessionId != widget.sessionId) {
      _agents = const [];
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
    final result = await context.read<BridgeService>().fetchSubagents(
      sessionId,
    );
    if (!mounted || sessionId != widget.sessionId) return;
    if (result.status == 404) {
      setState(() => _unsupported = true);
      return;
    }
    if (result.status == 200) setState(() => _agents = result.agents);
    _timer = Timer(_interval, _refresh);
  }

  int get _running => _agents.where((a) => a['state'] == 'running').length;

  @override
  Widget build(BuildContext context) {
    if (_unsupported || _agents.isEmpty) return const SizedBox.shrink();
    final running = _running;
    return IconButton(
      key: const ValueKey('appbar_subagents_button'),
      tooltip: running > 0 ? 'Subagents ($running running)' : 'Subagents',
      padding: EdgeInsets.zero,
      constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
      icon: Badge(
        isLabelVisible: running > 0,
        label: Text('$running'),
        child: Icon(
          Icons.account_tree_outlined,
          size: 18,
          color: Theme.of(context).colorScheme.onSurfaceVariant,
        ),
      ),
      onPressed: () => _showList(context),
    );
  }

  void _showList(BuildContext context) {
    final appColors = Theme.of(context).extension<AppColors>()!;
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
              for (final a in _agents)
                ListTile(
                  dense: true,
                  leading: SubagentStateDot(
                    state: a['state'] as String? ?? 'done',
                  ),
                  minLeadingWidth: 12,
                  title: Text(
                    subagentTitle(a),
                    overflow: TextOverflow.ellipsis,
                  ),
                  subtitle: Text(
                    [
                      subagentStateLabel(a['state'] as String? ?? 'done'),
                      if ((a['agentType'] as String?)?.isNotEmpty == true)
                        a['agentType'] as String,
                      if (a['updatedAt'] is num)
                        formatAgo(
                          DateTime.now().difference(
                            DateTime.fromMillisecondsSinceEpoch(
                              (a['updatedAt'] as num).toInt(),
                            ),
                          ),
                        ),
                    ].join('  ·  '),
                    style: TextStyle(fontSize: 12, color: appColors.subtleText),
                  ),
                  onTap: () {
                    Navigator.of(sheetContext).pop();
                    SubagentScreen.open(
                      context,
                      sessionId: widget.sessionId,
                      agentId: a['agentId'] as String?,
                      title: subagentTitle(a),
                    );
                  },
                ),
            ],
          ),
        ),
      ),
    );
  }
}
