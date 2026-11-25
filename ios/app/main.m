#import <QuartzCore/QuartzCore.h>
#import <UIKit/UIKit.h>
#include <math.h>
#include <stdint.h>

extern int32_t gpuix_ios_start(const char *bundle_path);
extern void gpuix_ios_tick_frame(double timestamp_ms);
extern void gpuix_ios_desired_fps(float *out_min, float *out_max, float *out_preferred);
extern void gpuix_ios_low_memory(void);
extern void gpuix_ios_set_status_bar_style(int32_t style);
extern void gpuix_ios_will_enter_foreground(void);
extern void gpuix_ios_did_become_active(void);
extern void gpuix_ios_will_resign_active(void);
extern void gpuix_ios_did_enter_background(void);
extern void gpuix_ios_will_terminate(void);

@interface GPUIXSceneDelegate : UIResponder <UIWindowSceneDelegate>
@property(nonatomic, strong) UIWindow *window;
@property(nonatomic, strong) CADisplayLink *displayLink;
@property(nonatomic) float lastMinFps;
@property(nonatomic) float lastMaxFps;
@property(nonatomic) float lastPreferredFps;
@property(nonatomic) BOOL loggedFrameRange;
@end

@implementation GPUIXSceneDelegate

- (void)syncDisplayLinkFrameRate {
  if (!self.displayLink) {
    return;
  }
  if (@available(iOS 15.0, *)) {
    float minFps = 10.0f;
    float maxFps = 60.0f;
    float prefFps = 60.0f;
    gpuix_ios_desired_fps(&minFps, &maxFps, &prefFps);
    if (fabsf(minFps - self.lastMinFps) > 0.5f ||
        fabsf(maxFps - self.lastMaxFps) > 0.5f ||
        fabsf(prefFps - self.lastPreferredFps) > 0.5f) {
      self.lastMinFps = minFps;
      self.lastMaxFps = maxFps;
      self.lastPreferredFps = prefFps;
      self.displayLink.preferredFrameRateRange = CAFrameRateRangeMake(minFps, maxFps, prefFps);
      if (!self.loggedFrameRange) {
        self.loggedFrameRange = YES;
        NSLog(@"[GPUIX-iOS] Initial CAFrameRateRange min=%.0f max=%.0f preferred=%.0f", minFps, maxFps, prefFps);
      }
    }
  }
}

- (void)scene:(UIScene *)scene
    willConnectToSession:(UISceneSession *)session
                 options:(UISceneConnectionOptions *)connectionOptions {
  (void)session;
  (void)connectionOptions;
  if (![scene isKindOfClass:[UIWindowScene class]]) {
    return;
  }

  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    NSBundle *bundle = [NSBundle mainBundle];
    NSString *statusStyle = [bundle objectForInfoDictionaryKey:@"GPUIXStatusBarStyle"];
    if ([statusStyle isKindOfClass:[NSString class]] && [statusStyle isEqualToString:@"dark"]) {
      gpuix_ios_set_status_bar_style(0);
    } else {
      gpuix_ios_set_status_bar_style(1);
    }

    NSString *path = [bundle pathForResource:@"app" ofType:@"hbc" inDirectory:@"gpuix"];
    if (!path) {
      path = [bundle pathForResource:@"app" ofType:@"js" inDirectory:@"gpuix"];
    }
    if (!path) {
      NSLog(@"[GPUIX-iOS] Missing gpuix/app.hbc and gpuix/app.js in main bundle");
      return;
    }

    int32_t status = gpuix_ios_start([path UTF8String]);
    if (status != 0) {
      NSLog(@"[GPUIX-iOS] gpuix_ios_start failed with status=%d", status);
      return;
    }

    UIWindowScene *windowScene = (UIWindowScene *)scene;
    if (windowScene.windows.count > 0) {
      self.window = windowScene.windows.firstObject;
    }

    self.displayLink = [CADisplayLink displayLinkWithTarget:self selector:@selector(onDisplayLink:)];
    [self syncDisplayLinkFrameRate];
    [self.displayLink addToRunLoop:[NSRunLoop mainRunLoop] forMode:NSRunLoopCommonModes];
  });
}

- (void)onDisplayLink:(CADisplayLink *)link {
  gpuix_ios_tick_frame(link.timestamp * 1000.0);
  [self syncDisplayLinkFrameRate];
}

- (void)sceneWillEnterForeground:(UIScene *)scene {
  (void)scene;
  self.displayLink.paused = NO;
  [self syncDisplayLinkFrameRate];
  gpuix_ios_will_enter_foreground();
}

- (void)sceneDidBecomeActive:(UIScene *)scene {
  (void)scene;
  self.displayLink.paused = NO;
  [self syncDisplayLinkFrameRate];
  gpuix_ios_did_become_active();
}

- (void)sceneWillResignActive:(UIScene *)scene {
  (void)scene;
  self.displayLink.paused = YES;
  gpuix_ios_will_resign_active();
}

- (void)sceneDidEnterBackground:(UIScene *)scene {
  (void)scene;
  self.displayLink.paused = YES;
  gpuix_ios_did_enter_background();
}

- (void)sceneDidDisconnect:(UIScene *)scene {
  (void)scene;
  [self.displayLink invalidate];
  self.displayLink = nil;
}

@end

@interface GPUIXAppDelegate : UIResponder <UIApplicationDelegate>
@end

@implementation GPUIXAppDelegate

- (BOOL)application:(UIApplication *)application
    didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
  (void)application;
  (void)launchOptions;
  return YES;
}

- (UISceneConfiguration *)application:(UIApplication *)application
    configurationForConnectingSceneSession:(UISceneSession *)connectingSceneSession
                                   options:(UISceneConnectionOptions *)options {
  (void)application;
  (void)options;
  return [[UISceneConfiguration alloc] initWithName:@"Default Configuration"
                                        sessionRole:connectingSceneSession.role];
}

- (void)applicationDidReceiveMemoryWarning:(UIApplication *)application {
  (void)application;
  gpuix_ios_low_memory();
}

- (void)applicationWillTerminate:(UIApplication *)application {
  (void)application;
  gpuix_ios_will_terminate();
}

@end

int main(int argc, char *argv[]) {
  @autoreleasepool {
    return UIApplicationMain(argc, argv, nil, NSStringFromClass([GPUIXAppDelegate class]));
  }
}
