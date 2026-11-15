/** 设置型卡内的一列灰字：没有数据时的说明，或卡片开头的一段说明（server-web-list-pages design D10）。 */
export function CardNote({ children }: { children: string }) {
  return <p className="m-0 px-4 py-3 text-[13px] text-muted-foreground">{children}</p>;
}
