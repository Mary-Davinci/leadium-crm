import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Lead } from "../pratiche.types";
import { CrmTask } from "../../../store/crm-store";

export type PracticeActionsMenuProps = {
  lead: Lead;
  linkedTask: CrmTask | null;
  availableStatuses: string[];
  isUrgent: boolean;
  onOpen: (id: string) => void;
  onStartCall: (lead: Lead) => void;
  onRegisterCall: (lead: Lead) => void;
  onWrite: (lead: Lead) => void;
  onQuickTask: (lead: Lead) => void;
  onStatusChange: (leadId: string, status: string) => void;
  onAssign: (lead: Lead) => void;
  onMarkUrgent: (lead: Lead) => void;
};

export function PracticeActionsMenu({
  lead,
  linkedTask,
  availableStatuses,
  isUrgent,
  onOpen,
  onStartCall,
  onRegisterCall,
  onWrite,
  onQuickTask,
  onStatusChange,
  onAssign,
  onMarkUrgent
}: PracticeActionsMenuProps) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="pr-row-menu-trigger"
          aria-label={`Azioni per ${lead.fullName}`}
          onClick={(event) => event.stopPropagation()}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="3" r="1.3" />
            <circle cx="8" cy="8" r="1.3" />
            <circle cx="8" cy="13" r="1.3" />
          </svg>
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="pr-row-menu-content"
          align="end"
          sideOffset={6}
          onClick={(event) => event.stopPropagation()}
        >
          <DropdownMenu.Item className="pr-row-menu-item" onSelect={() => onOpen(lead.id)}>
            Apri pratica
          </DropdownMenu.Item>

          <DropdownMenu.Separator className="pr-row-menu-separator" />

          <DropdownMenu.Item className="pr-row-menu-item" onSelect={() => onStartCall(lead)}>
            Chiama
          </DropdownMenu.Item>
          <DropdownMenu.Item className="pr-row-menu-item" onSelect={() => onRegisterCall(lead)}>
            Registra chiamata rapida
          </DropdownMenu.Item>
          <DropdownMenu.Item className="pr-row-menu-item" onSelect={() => onWrite(lead)}>
            Scrivi
          </DropdownMenu.Item>

          <DropdownMenu.Separator className="pr-row-menu-separator" />

          <DropdownMenu.Item className="pr-row-menu-item" onSelect={() => onQuickTask(lead)}>
            Crea follow-up
          </DropdownMenu.Item>
          <DropdownMenu.Item className="pr-row-menu-item" onSelect={() => onAssign(lead)}>
            Assegna
          </DropdownMenu.Item>
          {!isUrgent ? (
            <DropdownMenu.Item className="pr-row-menu-item" onSelect={() => onMarkUrgent(lead)}>
              Segna urgente
            </DropdownMenu.Item>
          ) : null}

          {availableStatuses.length ? (
            <>
              <DropdownMenu.Separator className="pr-row-menu-separator" />
              <DropdownMenu.Sub>
                <DropdownMenu.SubTrigger className="pr-row-menu-item pr-row-menu-subtrigger">
                  Cambia stato
                </DropdownMenu.SubTrigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.SubContent className="pr-row-menu-content" sideOffset={4}>
                    {availableStatuses.map((status) => (
                      <DropdownMenu.Item
                        key={status}
                        className="pr-row-menu-item"
                        onSelect={() => onStatusChange(lead.id, status)}
                      >
                        {status}
                      </DropdownMenu.Item>
                    ))}
                  </DropdownMenu.SubContent>
                </DropdownMenu.Portal>
              </DropdownMenu.Sub>
            </>
          ) : null}
          {linkedTask ? (
            <>
              <DropdownMenu.Separator className="pr-row-menu-separator" />
              <div className="pr-row-menu-note">Task collegato: {linkedTask.title}</div>
            </>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
