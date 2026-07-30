import AppKit
import Foundation
import WebKit

struct LayoutMetrics: Codable {
    let chartTop: Double
    let chartBottom: Double
    let chartContentBottom: Double
    let firstItemTop: Double
    let outerGap: Double
    let visibleGap: Double
    let mainScrollTop: Double
    let barsBoxHeight: Double
    let barsClientHeight: Int
    let barsScrollHeight: Int
    let barsClientWidth: Int
    let barsScrollWidth: Int
    let overflowX: String
    let overflowY: String
}

struct LayoutResult: Codable {
    let before: LayoutMetrics
    let after: LayoutMetrics
}

final class ChartLayoutProbe: NSObject, WKNavigationDelegate {
    private let webView: WKWebView
    private var window: NSWindow?
    private var timeout: Timer?

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        webView = WKWebView(
            frame: NSRect(x: 0, y: 0, width: 1120, height: 760),
            configuration: configuration
        )
        super.init()
        webView.navigationDelegate = self
    }

    func run(indexURL: URL) {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1120, height: 760),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.contentView = webView
        window.orderFrontRegardless()
        self.window = window
        timeout = Timer.scheduledTimer(withTimeInterval: 15, repeats: false) { _ in
            fputs("Timed out probing WKWebView chart layout\n", stderr)
            NSApp.terminate(nil)
        }
        webView.loadFileURL(
            indexURL,
            allowingReadAccessTo: indexURL.deletingLastPathComponent()
        )
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let setup = #"""
          document.body.innerHTML = `
            <main class="main">
              <div class="list-layout visible">
                <div class="time-chart visible" id="probeChart">
                  <div class="chart-bars" id="probeBars">
                    <div class="chart-content" style="min-width: 2200px">
                      <div class="chart-bars-row">
                        <div class="chart-bar-group has-data">
                          <div class="chart-bar" id="probeBar" style="height: 44px"></div>
                        </div>
                      </div>
                      <div class="chart-axis">
                        <span class="chart-month" style="left: 0">2026-07</span>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="section-results-wrapper">
                  <div class="results-container">
                    <div class="result-item" id="probeItem">
                      <div class="result-row">
                        <div class="card-row">
                          <div class="result-title">Owned list page</div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </main>
          `;
          document.documentElement.dataset.theme = 'light';
          document.body.style.width = '1120px';
          document.body.style.height = '760px';
        """#

        webView.evaluateJavaScript(setup) { _, error in
            if let error {
                self.fail("Failed to set up chart probe: \(error)")
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                self.measure { before in
                    guard let before else { return }
                    webView.evaluateJavaScript(
                        "document.getElementById('probeBar').classList.add('highlighted')"
                    ) { _, error in
                        if let error {
                            self.fail("Failed to highlight chart bar: \(error)")
                            return
                        }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                            self.measure { after in
                                guard let after else { return }
                                self.finish(before: before, after: after)
                            }
                        }
                    }
                }
            }
        }
    }

    private func measure(completion: @escaping (LayoutMetrics?) -> Void) {
        let script = #"""
          (() => {
            const chart = document.getElementById('probeChart');
            const bars = document.getElementById('probeBars');
            const item = document.getElementById('probeItem');
            const chartRect = chart.getBoundingClientRect();
            const contentRect = bars
              .querySelector('.chart-content')
              .getBoundingClientRect();
            const itemRect = item.getBoundingClientRect();
            const style = getComputedStyle(bars);
            return {
              chartTop: chartRect.top,
              chartBottom: chartRect.bottom,
              chartContentBottom: contentRect.bottom,
              firstItemTop: itemRect.top,
              outerGap: itemRect.top - chartRect.bottom,
              visibleGap: itemRect.top - contentRect.bottom,
              mainScrollTop: document.querySelector('.main').scrollTop,
              barsBoxHeight: bars.getBoundingClientRect().height,
              barsClientHeight: bars.clientHeight,
              barsScrollHeight: bars.scrollHeight,
              barsClientWidth: bars.clientWidth,
              barsScrollWidth: bars.scrollWidth,
              overflowX: style.overflowX,
              overflowY: style.overflowY,
            };
          })()
        """#
        webView.evaluateJavaScript(script) { value, error in
            if let error {
                self.fail("Failed to measure chart layout: \(error)")
                completion(nil)
                return
            }
            guard
                let object = value as? [String: Any],
                let data = try? JSONSerialization.data(withJSONObject: object),
                let metrics = try? JSONDecoder().decode(LayoutMetrics.self, from: data)
            else {
                self.fail("WKWebView returned invalid chart metrics")
                completion(nil)
                return
            }
            completion(metrics)
        }
    }

    private func finish(before: LayoutMetrics, after: LayoutMetrics) {
        timeout?.invalidate()
        let result = LayoutResult(before: before, after: after)
        do {
            let data = try JSONEncoder().encode(result)
            print(String(decoding: data, as: UTF8.self))
            NSApp.terminate(nil)
        } catch {
            fail("Failed to encode chart metrics: \(error)")
        }
    }

    private func fail(_ message: String) {
        timeout?.invalidate()
        fputs("\(message)\n", stderr)
        NSApp.terminate(nil)
    }
}

guard CommandLine.arguments.count == 2 else {
    fputs("Usage: macos-wkwebview-chart-layout <desktop-index.html>\n", stderr)
    exit(2)
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let probe = ChartLayoutProbe()
probe.run(indexURL: URL(fileURLWithPath: CommandLine.arguments[1]))
app.run()
