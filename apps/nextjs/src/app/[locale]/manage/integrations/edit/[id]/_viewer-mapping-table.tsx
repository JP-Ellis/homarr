"use client";

import { Alert, Badge, Button, Fieldset, Group, Loader, Select, Stack, Table, Text } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";

import type { RouterOutputs } from "@homarr/api";
import { clientApi } from "@homarr/api/client";
import { showErrorNotification } from "@homarr/notifications";
import { useI18n } from "@homarr/translation/client";

interface ViewerMappingTableProps {
  integrationId: string;
}

type ViewerMappings = RouterOutputs["integration"]["viewerMappings"];

export const ViewerMappingTable = ({ integrationId }: ViewerMappingTableProps) => {
  const tMapping = useI18n("integration.viewerMapping");
  const { data, isPending, isError } = clientApi.integration.viewerMappings.useQuery({ integrationId });

  return (
    <Fieldset legend={tMapping("title")}>
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          {tMapping("description")}
        </Text>
        {isPending && <Loader size="sm" />}
        {isError && (
          <Alert icon={<IconAlertTriangle size={"1rem"} />} color="red">
            {tMapping("loadError")}
          </Alert>
        )}
        {data && <ViewerMappingRows integrationId={integrationId} data={data} />}
      </Stack>
    </Fieldset>
  );
};

const ViewerMappingRows = ({ integrationId, data }: { integrationId: string; data: ViewerMappings }) => {
  const tMapping = useI18n("integration.viewerMapping");
  const utils = clientApi.useUtils();
  const onError = () => showErrorNotification({ message: tMapping("saveError") });
  const onSuccess = () => utils.integration.viewerMappings.invalidate({ integrationId });
  const { mutate: saveMapping, isPending: isSaving } = clientApi.integration.saveViewerMapping.useMutation({
    onError,
    onSuccess,
  });
  const { mutate: deleteMapping, isPending: isDeleting } = clientApi.integration.deleteViewerMapping.useMutation({
    onError,
    onSuccess,
  });

  const userOptions = data.integrationUsers.map((user) => ({ value: user.id, label: user.displayName }));
  const displayNameById = new Map(data.integrationUsers.map((user) => [user.id, user.displayName]));
  const isBusy = isSaving || isDeleting;

  return (
    <Table.ScrollContainer minWidth={560}>
      <Table verticalSpacing="xs">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{tMapping("column.user")}</Table.Th>
            <Table.Th>{tMapping("column.automatic")}</Table.Th>
            <Table.Th>{tMapping("column.override")}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {data.users.map((row) => {
            const userName = row.userName ?? row.userId;
            // An override can point at a service user that no longer exists, so the stored ID is shown as a fallback.
            const overrideOptions =
              row.override !== null && !displayNameById.has(row.override)
                ? [...userOptions, { value: row.override, label: row.override }]
                : userOptions;

            return (
              <Table.Tr key={row.userId}>
                <Table.Td>
                  <Group gap="xs">
                    <Text size="sm">{userName}</Text>
                    <Badge variant="light" color="gray" size="xs">
                      {row.provider}
                    </Badge>
                  </Group>
                </Table.Td>
                <Table.Td>
                  {row.automatic.status === "matched" ? (
                    <Text size="sm">
                      {displayNameById.get(row.automatic.externalUserId) ?? row.automatic.externalUserId}
                    </Text>
                  ) : (
                    <Text size="sm" c="dimmed">
                      {tMapping("notLinked")}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Group gap="xs" wrap="nowrap">
                    <Select
                      aria-label={tMapping("overrideFor", { name: userName })}
                      placeholder={tMapping("automaticPlaceholder")}
                      data={overrideOptions}
                      value={row.override}
                      searchable
                      disabled={isBusy}
                      onChange={(value) => {
                        if (value === null) return;
                        saveMapping({ integrationId, userId: row.userId, externalUserId: value });
                      }}
                    />
                    <Button
                      variant="subtle"
                      color="gray"
                      size="xs"
                      disabled={row.override === null || isBusy}
                      onClick={() => deleteMapping({ integrationId, userId: row.userId })}
                    >
                      {tMapping("clear")}
                    </Button>
                  </Group>
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
};
