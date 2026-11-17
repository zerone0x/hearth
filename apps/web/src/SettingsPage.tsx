/**
 * Settings (PRD §6.10, decision 0038): the model card and the secrets table.
 * The model's key is picked from the vault; secrets are added, rotated and
 * deleted here. No value is ever read back: the page shows keyed fingerprints,
 * and a dialog's typed values are dropped when it closes.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api, type ModelSettings, type Secret, type SecretKind } from "./api";
import { ErrorAlert } from "./ErrorAlert";
import { keys } from "./queries";

/** The encrypted fields of each kind, as the hub's vault takes them (decision 0031). */
export const KIND_FIELDS: Record<SecretKind, readonly string[]> = {
  "model-key": ["value"],
  token: ["value"],
  login: ["username", "password"],
};

const KIND_LABEL: Record<SecretKind, string> = {
  "model-key": "Model key",
  token: "Token",
  login: "Site login",
};

/** The Select's value for "no key". */
const NO_KEY = "none";

export default function SettingsPage() {
  const vault = useQuery({ queryKey: keys.vaultStatus, queryFn: api.vaultStatus });
  const secrets = useQuery({ queryKey: keys.secrets, queryFn: api.secrets });
  const disabled = vault.data?.state === "disabled" ? vault.data : undefined;
  return (
    <>
      <h1 className="text-xl font-semibold">Settings</h1>
      <ErrorAlert error={vault.error ?? secrets.error} />
      {disabled === undefined ? null : (
        <Alert variant="destructive" role="alert">
          <AlertTitle>The vault is off ({disabled.reason})</AlertTitle>
          <AlertDescription>{disabled.message}</AlertDescription>
        </Alert>
      )}
      <ModelCard secrets={secrets.data ?? []} />
      <SecretsCard secrets={secrets.data} vaultOn={vault.data?.state === "enabled"} />
    </>
  );
}

function ModelCard({ secrets }: { secrets: readonly Secret[] }) {
  const settings = useQuery({ queryKey: keys.modelSettings, queryFn: api.modelSettings });
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Model</h2>
        </CardTitle>
        <CardDescription>
          The model new turns use, and its key from the vault. A turn already running keeps the
          model it started with.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ErrorAlert error={settings.error} />
        {settings.data === undefined ? (
          settings.isError ? null : (
            <p className="text-muted-foreground">Loading…</p>
          )
        ) : (
          // Keyed by the source: the form starts from the loaded state, and a save
          // (which already matches it) keeps the form and its "Saved" line.
          <ModelForm
            key={settings.data.source === "env" ? "env" : "page"}
            settings={settings.data}
            keys={secrets.filter((s) => s.kind === "model-key" && s.scope === null)}
          />
        )}
      </CardContent>
    </Card>
  );
}

function ModelForm({ settings, keys: modelKeys }: { settings: ModelSettings; keys: Secret[] }) {
  const client = useQueryClient();
  const [provider, setProvider] = useState(settings.provider ?? "");
  const [model, setModel] = useState(settings.model ?? "");
  const [keyRef, setKeyRef] = useState(settings.keyRef ?? NO_KEY);
  const save = useMutation({
    mutationFn: () =>
      api.saveModelSettings({
        provider: provider.trim(),
        model: model.trim(),
        keyRef: keyRef === NO_KEY ? null : keyRef,
      }),
    onSuccess: (saved) => client.setQueryData(keys.modelSettings, saved),
  });
  const locked = settings.source === "env";

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }

  // The saved key may name an entry that is gone or not a vault key: still show it.
  const options = modelKeys.map((s) => ({
    ref: `vault:${s.name}`,
    label: s.name,
    fp: s.fingerprint,
  }));
  if (keyRef !== NO_KEY && !options.some((o) => o.ref === keyRef)) {
    options.push({ ref: keyRef, label: keyRef, fp: settings.keyFingerprint ?? "missing" });
  }
  return (
    <form className="flex flex-col gap-3" onSubmit={onSubmit} aria-label="Model">
      {locked ? (
        <Alert>
          <AlertTitle>Set by deploy/.env</AlertTitle>
          <AlertDescription>
            HEARTH_MODEL is set, so the environment decides. Remove the HEARTH_MODEL* lines from
            deploy/.env and restart the hub to manage the model here.
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="model-provider">Provider</Label>
          <Input
            id="model-provider"
            placeholder="anthropic"
            autoComplete="off"
            value={provider}
            disabled={locked}
            onChange={(e) => setProvider(e.target.value)}
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="model-id">Model</Label>
          <Input
            id="model-id"
            placeholder="claude-sonnet-4-5"
            autoComplete="off"
            value={model}
            disabled={locked}
            onChange={(e) => setModel(e.target.value)}
            required
          />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="model-key">Key</Label>
        <Select value={keyRef} onValueChange={setKeyRef} disabled={locked}>
          <SelectTrigger id="model-key" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_KEY}>No key</SelectItem>
            {options.map((o) => (
              <SelectItem key={o.ref} value={o.ref}>
                {o.label} <span className="font-mono text-muted-foreground">{o.fp}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Add a model key under Secrets first; only global model keys are listed.
        </p>
      </div>
      <ErrorAlert error={save.error} />
      {save.isSuccess ? (
        <p className="text-sm text-muted-foreground" role="status">
          {`Saved. New turns use ${save.data.provider}/${save.data.model}.`}
        </p>
      ) : null}
      {locked ? null : (
        <Button type="submit" className="self-start" disabled={save.isPending}>
          Save
        </Button>
      )}
    </form>
  );
}

function SecretsCard({ secrets, vaultOn }: { secrets: Secret[] | undefined; vaultOn: boolean }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div className="flex flex-col gap-1.5">
          <CardTitle>
            <h2>Secrets</h2>
          </CardTitle>
          <CardDescription>
            Values are encrypted in the vault and never shown again: compare fingerprints instead.
          </CardDescription>
        </div>
        <AddSecretDialog disabled={!vaultOn} />
      </CardHeader>
      <CardContent>
        {secrets === undefined ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : secrets.length === 0 ? (
          <p className="text-muted-foreground">No secrets yet.</p>
        ) : (
          <Table aria-label="Secrets">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Fingerprint</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {secrets.map((s) => (
                <TableRow key={s.id} data-testid="secret-row">
                  <TableCell>
                    <div className="font-medium">{s.name}</div>
                    {s.policy.origins?.length ? (
                      <div className="text-xs text-muted-foreground">
                        {s.policy.origins.join(", ")}
                      </div>
                    ) : null}
                    {s.policy.use === "box-env" ? (
                      <Badge variant="destructive">visible to commands in the box</Badge>
                    ) : null}
                  </TableCell>
                  <TableCell>{KIND_LABEL[s.kind] ?? s.kind}</TableCell>
                  <TableCell>
                    {s.scope === null ? "global" : `session ${s.scope.sessionId}`}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {s.fingerprint} <span className="text-muted-foreground">v{s.version}</span>
                  </TableCell>
                  <TableCell className="text-xs">
                    {s.lastUsedAt === null ? "never" : new Date(s.lastUsedAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <RotateSecretDialog secret={s} disabled={!vaultOn} />
                    <DeleteSecretDialog secret={s} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

/** Password-type inputs for a kind's fields; the values live only in the open dialog. */
function FieldInputs({
  kind,
  values,
  onChange,
  prefix,
}: {
  kind: SecretKind;
  values: Record<string, string>;
  onChange: (field: string, value: string) => void;
  prefix: string;
}) {
  return KIND_FIELDS[kind].map((field) => (
    <div key={field} className="flex flex-col gap-1.5">
      <Label htmlFor={`${prefix}-${field}`}>{field === "value" ? "Value" : field}</Label>
      <Input
        id={`${prefix}-${field}`}
        type={field === "username" ? "text" : "password"}
        autoComplete="off"
        value={values[field] ?? ""}
        onChange={(e) => onChange(field, e.target.value)}
        required
      />
    </div>
  ));
}

function AddSecretDialog({ disabled }: { disabled: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" disabled={disabled}>
          Add secret
        </Button>
      </DialogTrigger>
      <DialogContent>
        {/* Unmounted on close: typed values do not outlive the dialog. */}
        <AddSecretForm />
      </DialogContent>
    </Dialog>
  );
}

function AddSecretForm() {
  const client = useQueryClient();
  const [kind, setKind] = useState<SecretKind>("model-key");
  const [name, setName] = useState("");
  const [origins, setOrigins] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const add = useMutation({
    mutationFn: () => {
      const fields = Object.fromEntries(KIND_FIELDS[kind].map((f) => [f, values[f] ?? ""]));
      return api.addSecret({
        name: name.trim(),
        kind,
        ...(kind === "login"
          ? {
              policy: {
                origins: origins
                  .split(/[\s,]+/)
                  .map((o) => o.trim())
                  .filter((o) => o !== ""),
              },
            }
          : {}),
        fields,
      });
    },
    onSuccess: () => {
      setValues({});
      void client.invalidateQueries({ queryKey: keys.secrets });
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    add.mutate();
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={onSubmit} aria-label="Add secret">
      <DialogHeader>
        <DialogTitle>Add a secret</DialogTitle>
        <DialogDescription>
          The value is encrypted at once and cannot be read back, only replaced.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="secret-kind">Kind</Label>
        <Select
          value={kind}
          onValueChange={(v) => {
            setKind(v as SecretKind);
            setValues({});
          }}
        >
          <SelectTrigger id="secret-kind" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(KIND_FIELDS) as SecretKind[]).map((k) => (
              <SelectItem key={k} value={k}>
                {KIND_LABEL[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="secret-name">Name</Label>
        <Input
          id="secret-name"
          className="font-mono"
          placeholder="anthropic-key"
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </div>
      {kind === "login" ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="secret-origins">Origins</Label>
          <Input
            id="secret-origins"
            placeholder="https://github.com"
            autoComplete="off"
            value={origins}
            onChange={(e) => setOrigins(e.target.value)}
            required
          />
          <p className="text-xs text-muted-foreground">
            The exact sites it may be filled on, separated by commas.
          </p>
        </div>
      ) : null}
      <FieldInputs
        kind={kind}
        prefix="secret"
        values={values}
        onChange={(f, v) => setValues((old) => ({ ...old, [f]: v }))}
      />
      <ErrorAlert error={add.error} />
      {add.isSuccess ? (
        <p className="text-sm" role="status">
          Saved. Fingerprint <span className="font-mono">{add.data.fingerprint}</span>
        </p>
      ) : null}
      <DialogFooter>
        <Button type="submit" disabled={add.isPending}>
          Add
        </Button>
      </DialogFooter>
    </form>
  );
}

function RotateSecretDialog({ secret, disabled }: { secret: Secret; disabled: boolean }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" disabled={disabled}>
          Rotate
        </Button>
      </DialogTrigger>
      <DialogContent>
        <RotateSecretForm secret={secret} />
      </DialogContent>
    </Dialog>
  );
}

function RotateSecretForm({ secret }: { secret: Secret }) {
  const client = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>({});
  const rotate = useMutation({
    mutationFn: () =>
      api.rotateSecret(
        secret.id,
        Object.fromEntries(KIND_FIELDS[secret.kind].map((f) => [f, values[f] ?? ""])),
      ),
    onSuccess: () => {
      setValues({});
      void client.invalidateQueries({ queryKey: keys.secrets });
      void client.invalidateQueries({ queryKey: keys.modelSettings });
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    rotate.mutate();
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={onSubmit} aria-label="Rotate secret">
      <DialogHeader>
        <DialogTitle>Rotate {secret.name}</DialogTitle>
        <DialogDescription>
          Replaces the value (now <span className="font-mono">{secret.fingerprint}</span>). A model
          key takes effect on the next turn.
        </DialogDescription>
      </DialogHeader>
      <FieldInputs
        kind={secret.kind}
        prefix="rotate"
        values={values}
        onChange={(f, v) => setValues((old) => ({ ...old, [f]: v }))}
      />
      <ErrorAlert error={rotate.error} />
      {rotate.isSuccess ? (
        <p className="text-sm" role="status">
          Rotated to version {rotate.data.version}. Fingerprint{" "}
          <span className="font-mono">{rotate.data.fingerprint}</span>
        </p>
      ) : null}
      <DialogFooter>
        <Button type="submit" disabled={rotate.isPending}>
          Rotate
        </Button>
      </DialogFooter>
    </form>
  );
}

function DeleteSecretDialog({ secret }: { secret: Secret }) {
  const client = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.deleteSecret(secret.id),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: keys.secrets });
      void client.invalidateQueries({ queryKey: keys.modelSettings });
    },
  });
  return (
    <>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="ghost" size="sm">
            Delete
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {secret.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Anything that uses vault:{secret.name} will fail. The value cannot be recovered.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => remove.mutate()}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ErrorAlert error={remove.error} />
    </>
  );
}
