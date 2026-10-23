import 'package:flutter/material.dart';

import '../../../l10n/app_localizations.dart';
import '../../../models/messages.dart';
import '../../../theme/app_theme.dart';
import '../state/session_list_state.dart';

class SessionFilterBar extends StatelessWidget {
  final SessionDisplayMode displayMode;
  final VoidCallback onToggleDisplayMode;
  final bool groupRecentSessions;
  final VoidCallback onToggleRecentGrouping;
  final ProviderFilter providerFilter;
  final VoidCallback onToggleProviderFilter;
  final List<({String key, String name})> projects;
  final String? currentProjectFilter;
  final ValueChanged<String?> onProjectFilterChanged;
  final bool namedOnly;
  final VoidCallback onToggleNamed;

  const SessionFilterBar({
    super.key,
    required this.displayMode,
    required this.onToggleDisplayMode,
    required this.groupRecentSessions,
    required this.onToggleRecentGrouping,
    required this.providerFilter,
    required this.onToggleProviderFilter,
    required this.projects,
    required this.currentProjectFilter,
    required this.onProjectFilterChanged,
    required this.namedOnly,
    required this.onToggleNamed,
  });

  @override
  Widget build(BuildContext context) {
    // Fork: wrap onto several lines instead of a sideways-scrolling row, so
    // every filter stays visible in a narrow session list pane. The
    // Claude/Codex provider switch is only shown when it is actually in use
    // (this bridge runs Claude only).
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        if (projects.isNotEmpty) _buildProjectDropdown(context),
        _buildNamedToggle(context),
        _buildGroupingToggle(context),
        _buildDisplayModeDropdown(context),
        if (providerFilter != ProviderFilter.all)
          _buildProviderDropdown(context),
      ],
    );
  }

  Widget _buildGroupingToggle(BuildContext context) {
    return _ActionChip(
      key: const ValueKey('recent_grouping_toggle'),
      icon: groupRecentSessions
          ? Icons.account_tree_outlined
          : Icons.view_list_outlined,
      label: groupRecentSessions ? 'By project' : 'Flat list',
      // Fork: this is a view switch, not a filter, so it is never drawn in
      // the "filter is on" accent colour (upstream lit it up for List).
      tooltip: groupRecentSessions
          ? 'Sessions are grouped by project. Click for one flat list.'
          : 'One flat list of sessions. Click to group by project.',
      onTap: onToggleRecentGrouping,
    );
  }

  Widget _buildDisplayModeDropdown(BuildContext context) {
    final l = AppLocalizations.of(context);
    final label = switch (displayMode) {
      SessionDisplayMode.first => l.sessionDisplayModeFirst,
      SessionDisplayMode.last => l.sessionDisplayModeLast,
      SessionDisplayMode.summary => l.sessionDisplayModeSummary,
    };

    return _ActionChip(
      icon: Icons.visibility_outlined,
      label: label,
      tooltip: l.tooltipDisplayMode,
      onTap: onToggleDisplayMode,
    );
  }

  Widget _buildProviderDropdown(BuildContext context) {
    final l = AppLocalizations.of(context);
    final label = switch (providerFilter) {
      ProviderFilter.all => l.allAiTools,
      ProviderFilter.claude => 'Claude',
      ProviderFilter.codex => 'Codex',
    };

    return _ActionChip(
      icon: Icons.smart_toy_outlined,
      label: label,
      tooltip: l.tooltipProviderFilter,
      onTap: onToggleProviderFilter,
      isActive: providerFilter != ProviderFilter.all,
    );
  }

  Widget _buildProjectDropdown(BuildContext context) {
    final l = AppLocalizations.of(context);
    final currentProject = projects
        .where((p) => p.key == currentProjectFilter)
        .firstOrNull;
    final fallbackLabel = switch (currentProjectFilter) {
      final key? when key.startsWith('project:') => l.projects,
      final path? => pathBasename(path),
      null => l.allProjects,
    };

    return _DropdownChip<String?>(
      anchorKey: const ValueKey('project_filter_chip'),
      icon: Icons.folder_outlined,
      label: currentProject?.name ?? fallbackLabel,
      tooltip: l.tooltipProjectFilter,
      items: [
        (value: null, label: l.allProjects),
        ...projects.map((p) => (value: p.key, label: p.name)),
      ],
      onSelected: onProjectFilterChanged,
      isActive: currentProjectFilter != null,
    );
  }

  Widget _buildNamedToggle(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final appColors = theme.extension<AppColors>()!;

    // Fork: clearer wording; the chip is highlighted (with a check mark)
    // only while the filter is on.
    return Tooltip(
      message: namedOnly
          ? 'Showing only sessions you gave a name. Click to show all.'
          : 'Show only sessions you gave a name (renamed).',
      child: Material(
        color: namedOnly ? cs.primaryContainer : cs.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(16),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onToggleNamed,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            decoration: BoxDecoration(
              border: Border.all(
                color: namedOnly
                    ? cs.primaryContainer
                    : cs.outlineVariant.withValues(alpha: 0.5),
              ),
              borderRadius: BorderRadius.circular(16),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  namedOnly ? Icons.check : Icons.label_outlined,
                  size: 14,
                  color: namedOnly
                      ? cs.onPrimaryContainer
                      : appColors.subtleText,
                ),
                const SizedBox(width: 6),
                Text(
                  'Named only',
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w500,
                    color: namedOnly
                        ? cs.onPrimaryContainer
                        : appColors.subtleText,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ActionChip extends StatelessWidget {
  final IconData icon;
  final String label;
  final String? tooltip;
  final VoidCallback onTap;
  final bool isActive;

  const _ActionChip({
    super.key,
    required this.icon,
    required this.label,
    this.tooltip,
    required this.onTap,
    this.isActive = false,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final appColors = theme.extension<AppColors>()!;

    Widget chip = Material(
      color: isActive ? cs.primaryContainer : cs.surfaceContainerHigh,
      borderRadius: BorderRadius.circular(16),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          decoration: BoxDecoration(
            border: Border.all(
              color: isActive
                  ? cs.primaryContainer
                  : cs.outlineVariant.withValues(alpha: 0.5),
            ),
            borderRadius: BorderRadius.circular(16),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                icon,
                size: 14,
                color: isActive ? cs.onPrimaryContainer : appColors.subtleText,
              ),
              const SizedBox(width: 6),
              Text(
                label,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                  color: isActive
                      ? cs.onPrimaryContainer
                      : appColors.subtleText,
                ),
              ),
            ],
          ),
        ),
      ),
    );

    if (tooltip != null) {
      return Tooltip(message: tooltip!, child: chip);
    }
    return chip;
  }
}

class _DropdownChip<T> extends StatelessWidget {
  final Key? anchorKey;
  final IconData icon;
  final String label;
  final String? tooltip;
  final List<({T value, String label})> items;
  final ValueChanged<T> onSelected;
  final bool isActive;

  const _DropdownChip({
    this.anchorKey,
    required this.icon,
    required this.label,
    this.tooltip,
    required this.items,
    required this.onSelected,
    this.isActive = false,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final appColors = theme.extension<AppColors>()!;

    Widget chip = MenuAnchor(
      key: anchorKey,
      builder: (context, controller, child) {
        return Material(
          color: isActive ? cs.primaryContainer : cs.surfaceContainerHigh,
          borderRadius: BorderRadius.circular(16),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: () {
              if (controller.isOpen) {
                controller.close();
              } else {
                controller.open();
              }
            },
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              decoration: BoxDecoration(
                border: Border.all(
                  color: isActive
                      ? cs.primaryContainer
                      : cs.outlineVariant.withValues(alpha: 0.5),
                ),
                borderRadius: BorderRadius.circular(16),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    icon,
                    size: 14,
                    color: isActive
                        ? cs.onPrimaryContainer
                        : appColors.subtleText,
                  ),
                  const SizedBox(width: 6),
                  Text(
                    label,
                    style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w500,
                      color: isActive
                          ? cs.onPrimaryContainer
                          : appColors.subtleText,
                    ),
                  ),
                  const SizedBox(width: 4),
                  Icon(
                    Icons.arrow_drop_down,
                    size: 16,
                    color: isActive
                        ? cs.onPrimaryContainer
                        : appColors.subtleText,
                  ),
                ],
              ),
            ),
          ),
        );
      },
      menuChildren: items.map((item) {
        return MenuItemButton(
          onPressed: () => onSelected(item.value),
          child: Text(item.label),
        );
      }).toList(),
    );

    if (tooltip != null) {
      return Tooltip(message: tooltip!, child: chip);
    }
    return chip;
  }
}
