// 확장 대시보드가 쓰는 chrome.* 최소 타입. @types/chrome 의존을 늘리지 않으려고 쓰는 API만 선언한다.
interface ChromeStorageChange {
  oldValue?: unknown
  newValue?: unknown
}

declare const chrome: {
  storage: {
    local: {
      get(keys?: string | string[] | null): Promise<Record<string, any>>
      set(items: Record<string, unknown>): Promise<void>
      remove(keys: string | string[]): Promise<void>
      clear(): Promise<void>
    }
    onChanged: {
      addListener(cb: (changes: Record<string, ChromeStorageChange>, area: string) => void): void
      removeListener(cb: (changes: Record<string, ChromeStorageChange>, area: string) => void): void
    }
  }
  runtime: {
    sendMessage(message: unknown): Promise<any>
    reload(): void
  }
  tabs: {
    query(info: { url?: string }): Promise<{ id?: number; url?: string }[]>
  }
  scripting: {
    executeScript(injection: { target: { tabId: number }; files: string[] }): Promise<unknown>
  }
}
